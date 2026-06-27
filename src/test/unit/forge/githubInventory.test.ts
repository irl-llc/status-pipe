/**
 * GitHub issue-inventory tests against the in-process FakeForgeServer — the
 * real GraphQL/REST transport, queries, and node mapping, plus the planner
 * adapter (forgeInventoryPort) that renames the surface into InventoryPort.
 */

import assert from 'node:assert/strict';

import { FakeForgeServer } from '../../../forge/fake/fakeForgeServer';
import { FakeIssue, FakeRepoData } from '../../../forge/fake/fakeForgeData';
import { GithubForge } from '../../../forge/github';
import { fetchHttpClient } from '../../../forge/http';
import { ForgeError, ForgeInventory } from '../../../forge/types';
import { forgeInventoryPort } from '../../../planner/forgeInventory';

function issue(over: Partial<FakeIssue> & Pick<FakeIssue, 'number' | 'title'>): FakeIssue {
	return { state: 'open', labels: ['agent-queue'], author: 'ed', assignees: ['ed'], ...over };
}

function repoData(over: Partial<FakeRepoData> = {}): FakeRepoData {
	return { slug: 'acme/x', viewerLogin: 'ed', prs: [], ...over };
}

describe('forge/githubInventory (FakeForgeServer)', () => {
	let server: FakeForgeServer;

	async function inventory(data: FakeRepoData): Promise<ForgeInventory> {
		server = new FakeForgeServer(data);
		const baseUrl = await server.start();
		const forge = new GithubForge({ apiUrl: baseUrl, http: fetchHttpClient });
		const inv = forge.openInventory(forge.repositoryId('acme/x'), { token: 't' });
		assert.ok(inv, 'GitHub forge must provide an inventory');
		return inv;
	}

	afterEach(async () => {
		await server.stop();
	});

	describe('visibility', () => {
		it('maps PUBLIC → public and a private repo → private', async () => {
			assert.equal(await (await inventory(repoData({ visibility: 'public' }))).visibility(), 'public');
			await server.stop();
			assert.equal(await (await inventory(repoData({ visibility: 'private' }))).visibility(), 'private');
		});

		it('fails closed to public when the repo is present but its visibility is unknown', async () => {
			// A present repo with a null visibility field maps to 'public' (which
			// refuses to tick without a trust mode), not the permissive 'private'.
			assert.equal(await (await inventory(repoData({ repoVisibilityAbsent: true }))).visibility(), 'public');
		});

		it('throws not-found rather than failing closed to private when the repo is missing', async () => {
			const inv = await inventory(repoData({ repoMissing: true }));
			await assert.rejects(inv.visibility(), (e: unknown) => e instanceof ForgeError && e.kind === 'not-found');
		});

		it('maps INTERNAL (org-wide readable) to public so it refuses without a trust mode', async () => {
			// INTERNAL is `.private===false`; treating it as 'private' would auto-trust
			// a single maintainer for a repo the whole org can drive — fail closed.
			assert.equal(await (await inventory(repoData({ visibility: 'internal' }))).visibility(), 'public');
		});
	});

	it('reads the authenticated viewer login', async () => {
		const inv = await inventory(repoData({ viewerLogin: 'maintainer' }));
		assert.equal(await inv.viewerLogin(), 'maintainer');
	});

	describe('listLabeledIssues', () => {
		it('returns open issues carrying the label, fully mapped', async () => {
			const inv = await inventory(
				repoData({
					issues: [
						issue({ number: 7, title: 'Wire the queue', assignees: ['ed', 'sam'], author: 'sam' }),
						issue({ number: 8, title: 'Other label', labels: ['docs'] }),
						issue({ number: 9, title: 'Closed one', state: 'closed' }),
					],
				}),
			);
			const tickets = await inv.listLabeledIssues('agent-queue');
			assert.deepEqual(tickets, [
				{
					key: '7',
					title: 'Wire the queue',
					url: 'https://github.com/acme/x/issues/7',
					author: 'sam',
					assignees: ['ed', 'sam'],
				},
			]);
		});

		it('is empty when no open issue carries the label', async () => {
			const inv = await inventory(repoData({ issues: [issue({ number: 1, title: 'x', labels: ['docs'] })] }));
			assert.deepEqual(await inv.listLabeledIssues('agent-queue'), []);
		});

		it('throws not-found rather than an empty backlog when the repo is missing', async () => {
			const inv = await inventory(repoData({ repoMissing: true }));
			await assert.rejects(
				inv.listLabeledIssues('agent-queue'),
				(e: unknown) => e instanceof ForgeError && e.kind === 'not-found',
			);
		});
	});

	describe('getIssueStates', () => {
		it('returns open/closed plus the close reason, for issues open AND closed', async () => {
			const inv = await inventory(
				repoData({
					issues: [
						issue({ number: 7, title: 'still open' }),
						issue({ number: 8, title: 'merged', state: 'closed', stateReason: 'COMPLETED' }),
						issue({ number: 9, title: 'dropped', state: 'closed', stateReason: 'NOT_PLANNED' }),
					],
				}),
			);
			const states = await inv.getIssueStates(['7', '8', '9']);
			assert.deepEqual(states.get('7'), { state: 'open', stateReason: null });
			assert.deepEqual(states.get('8'), { state: 'closed', stateReason: 'completed' });
			assert.deepEqual(states.get('9'), { state: 'closed', stateReason: 'not_planned' });
		});

		it('fans a single deduped issue node back to every key that names the same number', async () => {
			const inv = await inventory(repoData({ issues: [issue({ number: 7, title: 'still open' })] }));
			// '7' and '07' parse to the same number — one alias is emitted, but both keys resolve.
			const states = await inv.getIssueStates(['7', '07']);
			assert.deepEqual(states.get('7'), { state: 'open', stateReason: null });
			assert.deepEqual(states.get('07'), { state: 'open', stateReason: null });
		});

		it('drops hex/whitespace/sign-formed keys instead of remapping them to another issue', async () => {
			const inv = await inventory(repoData({ issues: [issue({ number: 16, title: 'sixteen' })] }));
			// '0x10' Number-parses to 16; ' 7 '/'+7' to 7. The decimal-only guard rejects all three
			// so a malformed key never silently looks up an unrelated issue.
			const states = await inv.getIssueStates(['0x10', ' 7 ', '+7']);
			assert.equal(states.size, 0);
		});

		it('reports an open, re-opened issue as reopened (the reconcile revive signal)', async () => {
			const inv = await inventory(
				repoData({ issues: [issue({ number: 7, title: 'reopened', state: 'open', stateReason: 'REOPENED' })] }),
			);
			assert.deepEqual((await inv.getIssueStates(['7'])).get('7'), { state: 'open', stateReason: 'reopened' });
		});

		it('maps DUPLICATE to not_planned and a missing close reason to null', async () => {
			const inv = await inventory(
				repoData({
					issues: [
						issue({ number: 8, title: 'dup', state: 'closed', stateReason: 'DUPLICATE' }),
						issue({ number: 9, title: 'reasonless', state: 'closed', stateReason: null }),
					],
				}),
			);
			const states = await inv.getIssueStates(['8', '9']);
			assert.equal(states.get('8')?.stateReason, 'not_planned');
			assert.deepEqual(states.get('9'), { state: 'closed', stateReason: null });
		});

		it('omits a key whose issue does not exist, and short-circuits an empty/non-numeric request', async () => {
			const inv = await inventory(repoData({ issues: [issue({ number: 7, title: 'x' })] }));
			const states = await inv.getIssueStates(['7', '404', 'PROJ-1']);
			assert.deepEqual([...states.keys()], ['7']); // 404 (no issue) and the non-numeric key drop out
			assert.equal((await inv.getIssueStates([])).size, 0);
			assert.equal((await inv.getIssueStates(['PROJ-1'])).size, 0); // no numeric keys ⇒ no round trip
		});

		it('throws not-found rather than reporting "all gone" when the repo is missing', async () => {
			const inv = await inventory(repoData({ repoMissing: true }));
			await assert.rejects(
				inv.getIssueStates(['7']),
				(e: unknown) => e instanceof ForgeError && e.kind === 'not-found',
			);
		});
	});

	describe('findIssueByTitle', () => {
		const title = 'Epic: payments — implementation tracking';

		it('returns an exact-title match', async () => {
			const inv = await inventory(repoData({ issues: [issue({ number: 12, title })] }));
			const found = await inv.findIssueByTitle(title);
			assert.equal(found?.key, '12');
		});

		it('picks the exact match out of fuzzy search hits (the post-filter does the work)', async () => {
			// The fake returns BOTH (its title contains the phrase), so this only
			// passes if findIssueByTitle's exact-title filter rejects the `(v2)` one.
			const inv = await inventory(
				repoData({ issues: [issue({ number: 11, title: `${title} (v2)` }), issue({ number: 12, title })] }),
			);
			assert.equal((await inv.findIssueByTitle(title))?.key, '12');
		});

		it('returns null when only a fuzzy (non-exact) match exists', async () => {
			const inv = await inventory(repoData({ issues: [issue({ number: 12, title: `${title} (v2)` })] }));
			assert.equal(await inv.findIssueByTitle(title), null);
		});

		it('returns null when nothing matches', async () => {
			const inv = await inventory(repoData({ issues: [issue({ number: 1, title: 'unrelated' })] }));
			assert.equal(await inv.findIssueByTitle(title), null);
		});
	});

	describe('createLabeledIssue', () => {
		it('mints a labeled issue and returns its key/url/author', async () => {
			const inv = await inventory(repoData({ viewerLogin: 'ed' }));
			const created = await inv.createLabeledIssue('Epic: search — implementation tracking', 'agent-queue');
			assert.equal(created.key, '1');
			assert.equal(created.title, 'Epic: search — implementation tracking');
			assert.equal(created.url, 'https://github.com/acme/x/issues/1');
			assert.equal(created.author, 'ed');
			assert.deepEqual(
				server.createdIssues.map((i) => i.labels),
				[['agent-queue']],
			);
		});

		it('is then discoverable via listLabeledIssues', async () => {
			const inv = await inventory(repoData());
			await inv.createLabeledIssue('Epic: alpha — implementation tracking', 'agent-queue');
			const listed = await inv.listLabeledIssues('agent-queue');
			assert.deepEqual(
				listed.map((i) => i.title),
				['Epic: alpha — implementation tracking'],
			);
		});

		it('maps an HTTP failure on the create to the matching ForgeError kind', async () => {
			// 403 → rate-limit per statusToForgeError; this is the planner's one
			// mutation, so a failed mint must surface as a typed error, not a silent miss.
			const inv = await inventory(repoData({ createIssueStatus: 403 }));
			await assert.rejects(
				inv.createLabeledIssue('Epic: x — implementation tracking', 'agent-queue'),
				(e: unknown) => e instanceof ForgeError && e.kind === 'rate-limit',
			);
		});

		it('rejects a malformed create response (201 body missing `number`)', async () => {
			const inv = await inventory(repoData({ createIssueMalformed: true }));
			await assert.rejects(
				inv.createLabeledIssue('Epic: y — implementation tracking', 'agent-queue'),
				(e: unknown) => e instanceof ForgeError && e.kind === 'network' && /malformed/.test(e.message),
			);
		});
	});

	describe('forgeInventoryPort adapter', () => {
		it('maps the forge inventory onto the planner InventoryPort', async () => {
			const inv = await inventory(
				repoData({
					visibility: 'private',
					// Closed issue numbered BELOW the open one so the mint sequence (→ 4) is unperturbed.
					issues: [
						issue({ number: 2, title: 'Closed 2', state: 'closed', stateReason: 'COMPLETED' }),
						issue({ number: 3, title: 'Ticket 3' }),
					],
				}),
			);
			const port = forgeInventoryPort(inv);
			assert.equal(await port.visibility(), 'private');
			assert.equal(await port.viewerLogin(), 'ed');
			const tickets = await port.listLabeledTickets('agent-queue');
			assert.deepEqual(
				tickets.map((t) => t.key),
				['3'], // listLabeledTickets is open-only; 2 is closed
			);
			const states = await port.getTicketStates(['3', '2']);
			assert.deepEqual(states.get('3'), { state: 'open', stateReason: null });
			assert.deepEqual(states.get('2'), { state: 'closed', stateReason: 'completed' });
			const created = await port.createTrackingTicket('Epic: beta — implementation tracking', 'agent-queue');
			assert.equal(created.key, '4');
			const found = await port.findTrackingTicket('Ticket 3');
			assert.equal(found?.key, '3');
		});
	});
});
