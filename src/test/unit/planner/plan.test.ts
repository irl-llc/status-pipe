/**
 * End-to-end unit tests for the deterministic planner (src/planner/plan.ts),
 * driven entirely through in-memory fake ports — the test the LLM tick could
 * never have. Covers the trust gate, inventory + trust filtering, epic
 * tracking-ticket creation, ack consumption, staleness reconcile, the
 * fair-schedule/dispatch math, stamping, parking, and the orchestrator wrap.
 */

import assert from 'node:assert/strict';

import { WaitingOn } from '../../../protocol/types';
import { plan } from '../../../planner/plan';
import { FakePorts, makeInput, makeInventoryTicket, makeTicket, minutesAgo, NOW } from './fakes';

function owner(since: string): WaitingOn {
	return waiting('owner', since);
}

function waiting(kind: WaitingOn['kind'], since: string): WaitingOn {
	return { kind, ref: null, pr: null, since, detail: null };
}

describe('planner/plan', () => {
	describe('trust gate', () => {
		it('refuses a public repo with no declared trust mode', async () => {
			const ports = new FakePorts();
			ports.visibilityValue = 'public';
			const result = await plan(makeInput({ config: { trustMode: null } }), ports);
			assert.match(result.report.refusedReason ?? '', /public repo without a declared trust mode/);
			assert.equal(result.dispatch, null);
			assert.equal(ports.orchestratorWrites.length, 0); // refusal writes nothing
		});

		it('treats a visibility failure as public (fail closed)', async () => {
			const ports = new FakePorts();
			ports.visibilityThrows = true;
			const result = await plan(makeInput({ config: { trustMode: null } }), ports);
			assert.match(result.report.refusedReason ?? '', /public repo without a declared trust mode/);
		});

		it('defaults a private no-mode repo to single-maintainer (viewer)', async () => {
			const ports = new FakePorts();
			ports.viewer = 'ed';
			ports.labeled = [makeInventoryTicket({ key: '5', author: 'someone', assignees: [] })];
			const result = await plan(makeInput({ config: { trustMode: null } }), ports);
			assert.equal(result.report.refusedReason, null);
			assert.equal(result.dispatch?.items[0].key, '5'); // single-maintainer: label match is enough
		});

		it('refuses (does not crash) a private no-mode repo when viewer identity resolution fails', async () => {
			const ports = new FakePorts(); // visibility defaults to private
			ports.viewerThrows = true; // the forge identity read rejects
			const result = await plan(makeInput({ config: { trustMode: null } }), ports);
			assert.match(result.report.refusedReason ?? '', /no resolvable operator identity/);
			assert.equal(result.dispatch, null);
		});
	});

	describe('inventory + trust filtering', () => {
		it('dispatches a labeled ticket, minting its ticket file and a worktree', async () => {
			const ports = new FakePorts();
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			const result = await plan(makeInput(), ports);
			assert.deepEqual(result.dispatch?.items, [
				{ key: '5', kind: 'ticket', prompt: '/status-pipe:work-ticket 5', worktree: '/wt/ticket-5' },
			]);
			const stamped = ports.tickets.get('5');
			assert.equal(stamped?.worker?.status, 'running');
			assert.equal(stamped?.repo, 'acme/app');
			assert.equal(stamped?.title, 'Ticket 5');
			// A plain ticket keeps slug null — the GC reconstructs `ticket-5`, and a non-null
			// slug is the UI's epic marker (only epics persist it; see the epics suite).
			assert.equal(stamped?.slug, null);
			assert.deepEqual(ports.worktreeSlugs, ['ticket-5']);
		});

		it('multi-maintainer keeps only tickets assigned to an operator', async () => {
			const ports = new FakePorts();
			ports.labeled = [
				makeInventoryTicket({ key: 'mine', assignees: ['ed'] }),
				makeInventoryTicket({ key: 'theirs', assignees: ['other'] }),
			];
			const result = await plan(
				makeInput({ config: { trustMode: 'multi-maintainer', trustOperators: ['ed'] } }),
				ports,
			);
			assert.deepEqual(
				result.dispatch?.items.map((i) => i.key),
				['mine'],
			);
		});

		it('public mode keeps a ticket whose author is an operator', async () => {
			const ports = new FakePorts();
			ports.labeled = [makeInventoryTicket({ key: 'authored', author: 'ed', assignees: ['outsider'] })];
			const result = await plan(makeInput({ config: { trustMode: 'public', trustOperators: ['ed'] } }), ports);
			assert.deepEqual(
				result.dispatch?.items.map((i) => i.key),
				['authored'],
			);
		});

		it('assignee scope narrows beyond the trust filter', async () => {
			const ports = new FakePorts();
			ports.labeled = [
				makeInventoryTicket({ key: 'routed', assignees: ['bot'] }),
				makeInventoryTicket({ key: 'human', assignees: ['ed'] }),
			];
			const result = await plan(makeInput({ config: { inventoryAssignees: ['bot'] } }), ports);
			assert.deepEqual(
				result.dispatch?.items.map((i) => i.key),
				['routed'],
			);
		});
	});

	describe('epics', () => {
		it('creates a tracking ticket for a spec that lacks one and writes the header', async () => {
			const ports = new FakePorts();
			ports.epicSpecs = [{ slug: 'search', path: '/epics/search.md', title: 'Search', trackingTicket: null }];
			const result = await plan(makeInput(), ports);
			assert.equal(ports.createdTickets.length, 1);
			assert.match(ports.createdTickets[0].title, /^Epic: Search — implementation tracking$/);
			assert.deepEqual(result.report.createdTrackingTickets, ['search']);
			assert.equal(ports.headerWrites[0].path, '/epics/search.md');
			// The freshly-minted epic's stamped ticket file carries the forge URL the
			// planner already holds (not null), so its card has a clickable deep link.
			assert.equal(ports.tickets.get('epic-1')?.url, 'u/1');
			const item = result.dispatch?.items[0];
			assert.equal(item?.kind, 'epic');
			assert.equal(item?.prompt, '/status-pipe:work-epic /epics/search.md');
		});

		it("persists the dispatch slug into the epic's ticket file so the GC reclaims by it, not ticket-<key>", async () => {
			const ports = new FakePorts();
			ports.epicSpecs = [{ slug: 'search', path: '/epics/search.md', title: 'Search', trackingTicket: null }];
			await plan(makeInput(), ports);
			// The worktree was created under the spec slug; the file must record that same
			// slug (not null), or a later GC pass would guess `ticket-epic-1` and reclaim
			// the live worktree. (Only epics persist slug — a plain ticket stays null.)
			assert.equal(ports.tickets.get('epic-1')?.slug, 'search');
		});

		it('reuses an existing tracking ticket and dedupes it from labeled inventory', async () => {
			const ports = new FakePorts();
			ports.epicSpecs = [{ slug: 'search', path: '/epics/search.md', title: 'Search', trackingTicket: '42' }];
			ports.labeled = [makeInventoryTicket({ key: '42' })]; // same key as the epic's tracking ticket
			const result = await plan(makeInput(), ports);
			assert.equal(ports.createdTickets.length, 0);
			assert.equal(result.dispatch?.items.length, 1); // not double-counted
			assert.equal(result.dispatch?.items[0].kind, 'epic');
		});

		it('records created tracking tickets in spec order even when mints finish out of order', async () => {
			const ports = new FakePorts();
			ports.epicSpecs = [
				{ slug: 'alpha', path: '/epics/alpha.md', title: 'Alpha', trackingTicket: null },
				{ slug: 'bravo', path: '/epics/bravo.md', title: 'Bravo', trackingTicket: null },
				{ slug: 'charlie', path: '/epics/charlie.md', title: 'Charlie', trackingTicket: null },
			];
			// Make each find slow and in reverse-of-spec order. The resolve is
			// sequential, so the report must come out in spec order; a regression to an
			// unordered Promise.all recording mid-resolution would surface here as
			// ['charlie','bravo','alpha']. The report is part of the deterministic contract.
			const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
			ports.inventory.findTrackingTicket = async (title: string): Promise<null> => {
				await delay(title.includes('Alpha') ? 9 : title.includes('Bravo') ? 6 : 3);
				return null;
			};
			const result = await plan(makeInput(), ports);
			assert.deepEqual(result.report.createdTrackingTickets, ['alpha', 'bravo', 'charlie']);
		});

		it('reuses a tracking ticket rediscovered by title (header lost) without minting a duplicate', async () => {
			const ports = new FakePorts();
			ports.epicSpecs = [{ slug: 'search', path: '/epics/search.md', title: 'Search', trackingTicket: null }];
			// The spec lost its header, but the tracking issue still exists on the forge.
			ports.existingTracking.set(
				'Epic: Search — implementation tracking',
				makeInventoryTicket({ key: '42', url: 'u/42' }),
			);
			const result = await plan(makeInput(), ports);
			assert.equal(ports.createdTickets.length, 0); // reused, NOT minted
			assert.deepEqual(result.report.createdTrackingTickets, []); // not counted as created
			assert.deepEqual(ports.headerWrites[0], { path: '/epics/search.md', key: '42', url: 'u/42' }); // header re-stamped
			assert.equal(result.dispatch?.items[0].key, '42');
			assert.equal(result.dispatch?.items[0].kind, 'epic');
		});

		it('dedupes two specs that point at the same tracking ticket (one candidate, not two)', async () => {
			const ports = new FakePorts();
			ports.epicSpecs = [
				{ slug: 'a', path: '/epics/a.md', title: 'A', trackingTicket: '42' },
				{ slug: 'b', path: '/epics/b.md', title: 'B', trackingTicket: '42' }, // same tracking key
			];
			const result = await plan(makeInput(), ports);
			assert.equal(result.dispatch?.items.length, 1); // one worker, not two stamping ticket 42
			assert.equal(result.dispatch?.items[0].key, '42');
		});

		it('mints ONE tracking ticket for two untracked specs that share a title (no duplicate forge issue)', async () => {
			const ports = new FakePorts();
			ports.epicSpecs = [
				{ slug: 'search-a', path: '/epics/a.md', title: 'Search', trackingTicket: null },
				{ slug: 'search-b', path: '/epics/b.md', title: 'Search', trackingTicket: null }, // identical title
			];
			const result = await plan(makeInput(), ports);
			// createTrackingTicket is the planner's one irreversible side effect; two
			// same-titled specs must share a single mint, not each leak a forge issue.
			// A concurrent Promise.all would have both finds miss and mint twice.
			assert.equal(ports.createdTickets.length, 1);
			assert.deepEqual(result.report.createdTrackingTickets, ['search-a']); // counted once, on the first spec
			assert.equal(result.dispatch?.items.length, 1); // one candidate after dedupeByKey
		});
	});

	describe('ack consumption', () => {
		it('consumes a matching ack: history, deletion, top priority, note in the prompt', async () => {
			const ports = new FakePorts();
			const since = minutesAgo(10);
			ports.tickets.set('5', makeTicket({ ticket: '5', health: 'waiting', waitingOn: owner(since) }));
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			ports.acks = [
				{
					path: 'inbox/5/ack-aaaa1111.json',
					ack: {
						schemaVersion: 1,
						kind: 'ready-for-look',
						ticket: '5',
						ackId: 'aaaa1111',
						target: { waitingKind: 'owner', waitingSince: since, ref: null, pr: null },
						stateUpdatedAt: since,
						note: 'go ahead',
						createdAt: minutesAgo(2),
						createdBy: 'ed',
					},
				},
			];
			const result = await plan(makeInput(), ports);
			assert.deepEqual(result.report.consumedAcks, ['aaaa1111']);
			assert.deepEqual(ports.deletedAcks, ['inbox/5/ack-aaaa1111.json']);
			assert.equal(result.dispatch?.items[0].prompt, '/status-pipe:work-ticket 5 Operator ack note: "go ahead"');
			assert.ok(ports.tickets.get('5')?.history.some((h) => /owner ack aaaa1111 consumed: go ahead/.test(h.note)));
		});

		it('supersedes a stale ack and leaves the waiting ticket undispatched', async () => {
			const ports = new FakePorts();
			ports.tickets.set('5', makeTicket({ ticket: '5', health: 'waiting', waitingOn: owner(minutesAgo(3)) }));
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			ports.acks = [
				{
					path: 'inbox/5/ack-bbbb2222.json',
					ack: {
						schemaVersion: 1,
						kind: 'ready-for-look',
						ticket: '5',
						ackId: 'bbbb2222',
						target: { waitingKind: 'owner', waitingSince: minutesAgo(99), ref: null, pr: null },
						stateUpdatedAt: minutesAgo(99),
						note: null,
						createdAt: minutesAgo(2),
						createdBy: 'ed',
					},
				},
			];
			const result = await plan(makeInput(), ports);
			assert.deepEqual(result.report.supersededAcks, ['bbbb2222']);
			assert.equal(result.dispatch, null); // waiting + no live ack ⇒ not dispatchable
		});

		it('deletes an orphan ack whose ticket file is gone', async () => {
			const ports = new FakePorts();
			ports.acks = [
				{
					path: 'inbox/99/ack-cccc3333.json',
					ack: {
						schemaVersion: 1,
						kind: 'ready-for-look',
						ticket: '99',
						ackId: 'cccc3333',
						target: { waitingKind: 'owner', waitingSince: minutesAgo(5), ref: null, pr: null },
						stateUpdatedAt: minutesAgo(5),
						note: null,
						createdAt: minutesAgo(2),
						createdBy: 'ed',
					},
				},
			];
			const result = await plan(makeInput(), ports);
			assert.deepEqual(result.report.orphanedAcks, ['cccc3333']);
			assert.deepEqual(ports.deletedAcks, ['inbox/99/ack-cccc3333.json']);
		});
	});

	describe('staleness reconcile', () => {
		it('marks a running worker with a stale heartbeat as error and makes it relaunchable', async () => {
			const ports = new FakePorts();
			ports.tickets.set(
				'5',
				makeTicket({
					ticket: '5',
					worker: { status: 'running', taskId: null, startedAt: minutesAgo(90), heartbeatAt: minutesAgo(45) },
				}),
			);
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			const result = await plan(makeInput(), ports); // staleWorkerMinutes 30, heartbeat 45m old
			assert.deepEqual(result.report.staleReconciled, ['5']);
			assert.ok(ports.tickets.get('5')?.history.some((h) => /worker presumed crashed/.test(h.note)));
			assert.equal(result.dispatch?.items[0].key, '5'); // reconciled ⇒ no live worker ⇒ relaunched
		});

		it('leaves a fresh running worker alone', async () => {
			const ports = new FakePorts();
			ports.tickets.set(
				'5',
				makeTicket({
					ticket: '5',
					worker: { status: 'running', taskId: null, startedAt: minutesAgo(5), heartbeatAt: minutesAgo(2) },
					health: 'waiting',
				}),
			);
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			const result = await plan(makeInput({ liveWorkerKeys: ['5'] }), ports);
			assert.deepEqual(result.report.staleReconciled, []);
			assert.equal(result.dispatch, null); // live worker ⇒ never re-dispatched
		});

		it('does NOT reconcile a STALE heartbeat when the supervisor reports the worker live', async () => {
			const ports = new FakePorts();
			ports.tickets.set(
				'5',
				makeTicket({
					ticket: '5',
					// 45m-stale heartbeat — would normally reconcile, but the worker is
					// alive (mid long build/review) and just hasn't refreshed it.
					worker: { status: 'running', taskId: null, startedAt: minutesAgo(90), heartbeatAt: minutesAgo(45) },
				}),
			);
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			const result = await plan(makeInput({ liveWorkerKeys: ['5'] }), ports); // supervisor: 5 is live
			assert.deepEqual(result.report.staleReconciled, []); // not marked crashed (no split-brain)
			assert.equal(ports.tickets.get('5')?.worker?.status, 'running'); // ticket untouched
		});

		it('reconciles a running worker with NO heartbeat (corrupt ticket) — same verdict as the card', async () => {
			const ports = new FakePorts();
			ports.tickets.set(
				'5',
				makeTicket({
					ticket: '5',
					// Malformed/partial ticket: running but heartbeatAt is null. The card's
					// isWorkerStale falls back to the (stale) startedAt and flags it crashed;
					// the planner shares that predicate, so it reconciles too — no split-brain
					// where the card shows "(stale)" but the planner leaves it running forever.
					worker: { status: 'running', taskId: null, startedAt: minutesAgo(90), heartbeatAt: null },
				}),
			);
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			const result = await plan(makeInput(), ports);
			assert.deepEqual(result.report.staleReconciled, ['5']); // old heartbeat-only predicate would have skipped this
			assert.equal(result.dispatch?.items[0].key, '5'); // reconciled ⇒ relaunchable
		});

		it('reconciles a stale worker on a WAITING ticket but does NOT relaunch it (operator-gated)', async () => {
			const ports = new FakePorts();
			ports.tickets.set(
				'5',
				makeTicket({
					ticket: '5',
					health: 'waiting', // waiting on the operator
					worker: { status: 'running', taskId: null, startedAt: minutesAgo(90), heartbeatAt: minutesAgo(45) },
				}),
			);
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			const result = await plan(makeInput(), ports); // no ack consumed this pass
			// Reconciled — the card escalates (worker → error) — but NOT dispatched: a
			// worker that crashed while waiting on the operator stays operator-gated
			// until an ack is consumed, even though it was just reconciled this pass.
			assert.deepEqual(result.report.staleReconciled, ['5']);
			assert.equal(ports.tickets.get('5')?.worker?.status, 'error');
			assert.equal(result.dispatch, null);
		});
	});

	describe('fair-schedule', () => {
		it('caps dispatch by free slots (maxConcurrent − live workers) and defers the rest', async () => {
			const ports = new FakePorts();
			ports.labeled = [
				makeInventoryTicket({ key: 'a' }),
				makeInventoryTicket({ key: 'b' }),
				makeInventoryTicket({ key: 'c' }),
			];
			const result = await plan(makeInput({ maxConcurrent: 2, liveWorkerKeys: ['x'] }), ports);
			assert.equal(result.dispatch?.items.length, 1); // 2 − 1 live = 1 free
			assert.equal(result.report.deferred.length, 2);
		});

		it('a mid-batch git failure defers that item without stranding the rest of the pass', async () => {
			const ports = new FakePorts();
			ports.labeled = [makeInventoryTicket({ key: '5' }), makeInventoryTicket({ key: '6' })];
			ports.failWorktreeSlug = 'ticket-6'; // the 2nd item fails to provision its worktree
			const result = await plan(makeInput(), ports);
			// 5 is dispatched (stamped + in the written plan); 6 is deferred, not a zombie.
			assert.deepEqual(
				result.dispatch?.items.map((i) => i.key),
				['5'],
			);
			assert.equal(ports.tickets.get('5')?.worker?.status, 'running');
			assert.equal(ports.tickets.get('6'), undefined); // never stamped
			assert.ok(result.report.deferred.includes('6'));
			assert.equal(ports.orchestratorWrites.length, 1); // the pass still reached the wrap
		});

		it('orders ack-consumers first, then oldest updatedAt', async () => {
			const ports = new FakePorts();
			ports.tickets.set('old', makeTicket({ ticket: 'old', updatedAt: minutesAgo(60) }));
			ports.tickets.set(
				'new',
				makeTicket({ ticket: 'new', updatedAt: minutesAgo(1), health: 'waiting', waitingOn: owner(minutesAgo(20)) }),
			);
			ports.labeled = [makeInventoryTicket({ key: 'old' }), makeInventoryTicket({ key: 'new' })];
			ports.acks = [
				{
					path: 'inbox/new/ack-dddd4444.json',
					ack: {
						schemaVersion: 1,
						kind: 'ready-for-look',
						ticket: 'new',
						ackId: 'dddd4444',
						target: { waitingKind: 'owner', waitingSince: minutesAgo(20), ref: null, pr: null },
						stateUpdatedAt: minutesAgo(20),
						note: null,
						createdAt: minutesAgo(2),
						createdBy: 'ed',
					},
				},
			];
			const result = await plan(makeInput({ maxConcurrent: 1 }), ports);
			assert.equal(result.dispatch?.items[0].key, 'new'); // ack-consumer wins the single slot
		});

		it('excludes terminal and idle-waiting tickets from dispatch', async () => {
			const ports = new FakePorts();
			ports.tickets.set('done', makeTicket({ ticket: 'done', phase: 'merged' }));
			ports.tickets.set('wait', makeTicket({ ticket: 'wait', health: 'waiting', waitingOn: owner(minutesAgo(5)) }));
			ports.labeled = [makeInventoryTicket({ key: 'done' }), makeInventoryTicket({ key: 'wait' })];
			const result = await plan(makeInput(), ports);
			assert.equal(result.dispatch, null);
		});
	});

	describe('lifecycle reconcile — close', () => {
		it('closes a ticket whose forge issue closed-as-completed (→ merged) and excludes it from dispatch', async () => {
			const ports = new FakePorts();
			// awaiting-merge + waiting, NOT labeled (the merge dropped it from the open inventory).
			ports.tickets.set(
				'5',
				makeTicket({
					ticket: '5',
					phase: 'awaiting-merge',
					health: 'waiting',
					waitingOn: waiting('merge', minutesAgo(10)),
				}),
			);
			ports.ticketStates.set('5', { state: 'closed', stateReason: 'completed' });
			const result = await plan(makeInput(), ports);
			assert.deepEqual(result.report.closedByReconcile, ['5']);
			const t = ports.tickets.get('5');
			assert.equal(t?.phase, 'merged');
			assert.equal(t?.health, 'done');
			assert.ok(t?.history.some((h) => /forge issue closed \(completed\); merged by reconcile/.test(h.note)));
			assert.equal(result.dispatch, null); // terminal ⇒ never dispatched
		});

		it('closes a not-planned issue as abandoned', async () => {
			const ports = new FakePorts();
			ports.tickets.set('5', makeTicket({ ticket: '5', phase: 'implementation' }));
			ports.ticketStates.set('5', { state: 'closed', stateReason: 'not_planned' });
			const result = await plan(makeInput(), ports);
			assert.deepEqual(result.report.closedByReconcile, ['5']);
			assert.equal(ports.tickets.get('5')?.phase, 'abandoned');
		});

		it('does NOT close a ticket when the forge lookup fails (a hiccup must not abandon live work)', async () => {
			const ports = new FakePorts();
			ports.tickets.set('5', makeTicket({ ticket: '5', phase: 'implementation' }));
			ports.ticketStates.set('5', { state: 'closed', stateReason: 'completed' });
			ports.ticketStatesThrows = true;
			const result = await plan(makeInput(), ports);
			assert.deepEqual(result.report.closedByReconcile, []);
			assert.equal(ports.tickets.get('5')?.phase, 'implementation'); // untouched
		});

		it('does NOT close a non-candidate ticket whose issue is still open (de-queued, not closed)', async () => {
			const ports = new FakePorts();
			ports.tickets.set('5', makeTicket({ ticket: '5', phase: 'implementation' }));
			ports.ticketStates.set('5', { state: 'open', stateReason: null }); // label removed, issue still open
			const result = await plan(makeInput(), ports);
			assert.deepEqual(result.report.closedByReconcile, []);
			assert.equal(ports.tickets.get('5')?.phase, 'implementation');
		});

		it('does NOT re-close a ticket already terminal (no forge lookup for it)', async () => {
			const ports = new FakePorts();
			ports.tickets.set('5', makeTicket({ ticket: '5', phase: 'merged', health: 'done' }));
			const result = await plan(makeInput(), ports);
			assert.deepEqual(result.report.closedByReconcile, []); // terminal ⇒ excluded from the drift set
		});
	});

	describe('lifecycle reconcile — re-open', () => {
		it('revives a terminal ticket whose issue was re-opened, dispatching it the same pass with memory intact', async () => {
			const ports = new FakePorts();
			ports.tickets.set(
				'5',
				makeTicket({
					ticket: '5',
					phase: 'merged',
					health: 'done',
					history: [{ at: minutesAgo(99), phase: 'merging', note: 'prior work', runId: null }],
				}),
			);
			ports.labeled = [makeInventoryTicket({ key: '5' })]; // re-opened + still labeled ⇒ a candidate again
			ports.ticketStates.set('5', { state: 'open', stateReason: 'reopened' }); // the forge confirms the re-open
			const result = await plan(makeInput(), ports);
			assert.deepEqual(result.report.reopened, ['5']);
			const t = ports.tickets.get('5');
			assert.equal(t?.phase, 'planning');
			assert.equal(t?.health, 'ok');
			assert.ok(t?.history.some((h) => /prior work/.test(h.note))); // memory preserved
			assert.ok(t?.history.some((h) => /reopened by reconcile/.test(h.note)));
			assert.equal(result.dispatch?.items[0].key, '5'); // eligible again THIS pass
		});

		it('does NOT revive a merged+labeled ticket the forge does not report reopened (no flip-flop)', async () => {
			const ports = new FakePorts();
			ports.tickets.set('5', makeTicket({ ticket: '5', phase: 'merged', health: 'done' }));
			ports.labeled = [makeInventoryTicket({ key: '5' })]; // still labeled, but the issue was never re-opened
			ports.ticketStates.set('5', { state: 'open', stateReason: null });
			const result = await plan(makeInput(), ports);
			assert.deepEqual(result.report.reopened, []);
			assert.equal(ports.tickets.get('5')?.phase, 'merged'); // stays terminal — not re-dispatched every pass
			assert.equal(result.dispatch, null);
		});

		it('leaves a non-terminal candidate untouched (normal dispatch, nothing revived)', async () => {
			const ports = new FakePorts();
			ports.tickets.set('5', makeTicket({ ticket: '5', phase: 'implementation' }));
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			const result = await plan(makeInput(), ports);
			assert.deepEqual(result.report.reopened, []);
			assert.equal(ports.tickets.get('5')?.phase, 'implementation');
		});
	});

	describe('lifecycle reconcile — worktree GC', () => {
		const wt = (slug: string): { slug: string; path: string; branch: string | null } => ({
			slug,
			path: `/wt/${slug}`,
			branch: slug,
		});

		it('reclaims worktrees that back no active work, keeping candidates and non-terminal files', async () => {
			const ports = new FakePorts();
			ports.tickets.set('9', makeTicket({ ticket: '9', phase: 'merged' })); // settled
			ports.tickets.set('7', makeTicket({ ticket: '7', health: 'waiting', waitingOn: owner(minutesAgo(5)) }));
			ports.labeled = [makeInventoryTicket({ key: '5' }), makeInventoryTicket({ key: '7' })];
			ports.worktreeList = [wt('ticket-5'), wt('ticket-7'), wt('ticket-9'), { ...wt('epic-orphan'), branch: null }];
			await plan(makeInput(), ports);
			// ticket-5 (dispatched candidate) + ticket-7 (waiting, non-terminal) stay; the
			// settled ticket-9 and the file-less epic-orphan are reclaimed.
			assert.deepEqual(ports.removedWorktrees.sort(), ['epic-orphan', 'ticket-9']);
		});

		it('keeps the worktree of a re-opened ticket (revived ⇒ active again)', async () => {
			const ports = new FakePorts();
			ports.tickets.set('5', makeTicket({ ticket: '5', phase: 'merged', health: 'done' }));
			ports.labeled = [makeInventoryTicket({ key: '5' })]; // re-opened
			ports.ticketStates.set('5', { state: 'open', stateReason: 'reopened' });
			ports.worktreeList = [wt('ticket-5')];
			await plan(makeInput(), ports);
			assert.deepEqual(ports.removedWorktrees, []);
		});

		it('removes nothing when every worktree backs active work', async () => {
			const ports = new FakePorts();
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			ports.worktreeList = [wt('ticket-5')];
			await plan(makeInput(), ports);
			assert.deepEqual(ports.removedWorktrees, []);
		});

		it("keeps a live epic's worktree (slug ≠ ticket-<key>) while its spec is momentarily absent", async () => {
			const ports = new FakePorts();
			// Non-terminal epic ticket whose worktree is the spec slug `search`, but no spec
			// is listed this pass (operator mid-rename) and it isn't labeled ⇒ not a candidate.
			ports.tickets.set('42', makeTicket({ ticket: '42', slug: 'search', phase: 'implementation' }));
			ports.worktreeList = [wt('search')];
			await plan(makeInput(), ports);
			// activeSlugs reads the persisted slug, so the live worktree survives.
			assert.deepEqual(ports.removedWorktrees, []);
		});

		it("reclaims an epic's worktree by its persisted slug once the ticket is terminal", async () => {
			const ports = new FakePorts();
			ports.tickets.set('42', makeTicket({ ticket: '42', slug: 'search', phase: 'merged' }));
			ports.worktreeList = [wt('search')];
			await plan(makeInput(), ports);
			assert.deepEqual(ports.removedWorktrees, ['search']);
		});
	});

	describe('parked + orchestrator wrap', () => {
		it('parks an empty backlog', async () => {
			const ports = new FakePorts();
			const result = await plan(makeInput(), ports);
			assert.match(result.report.parked?.reason ?? '', /backlog empty/);
			assert.equal(result.report.parked?.recheckAfter, new Date(NOW + 6 * 60 * 60_000).toISOString());
		});

		it('counts only non-terminal items in the parked reason (merged ticket excluded)', async () => {
			const ports = new FakePorts();
			ports.tickets.set('5', makeTicket({ ticket: '5', phase: 'merged' }));
			ports.tickets.set('6', makeTicket({ ticket: '6', health: 'waiting', waitingOn: owner(minutesAgo(5)) }));
			ports.labeled = [makeInventoryTicket({ key: '5' }), makeInventoryTicket({ key: '6' })];
			const result = await plan(makeInput(), ports);
			assert.match(result.report.parked?.reason ?? '', /^1 active items all waiting on you/);
		});

		it('parks with an honest reason when every tracked item is already complete', async () => {
			const ports = new FakePorts();
			ports.tickets.set('5', makeTicket({ ticket: '5', phase: 'merged' }));
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			const result = await plan(makeInput(), ports);
			assert.match(result.report.parked?.reason ?? '', /all tracked work is complete/);
			assert.doesNotMatch(result.report.parked?.reason ?? '', /waiting on you/);
		});

		it('does NOT park when an active item is waiting on the world (build/CI) — keeps polling', async () => {
			const ports = new FakePorts();
			ports.tickets.set(
				'5',
				makeTicket({ ticket: '5', health: 'waiting', waitingOn: waiting('build', minutesAgo(5)) }),
			);
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			const result = await plan(makeInput(), ports);
			assert.equal(result.report.parked, null);
		});

		it('does NOT park when ANY active item waits on the world, even if others wait on you', async () => {
			const ports = new FakePorts();
			ports.tickets.set('5', makeTicket({ ticket: '5', health: 'waiting', waitingOn: owner(minutesAgo(5)) }));
			ports.tickets.set(
				'6',
				makeTicket({ ticket: '6', health: 'waiting', waitingOn: waiting('build', minutesAgo(2)) }),
			);
			ports.labeled = [makeInventoryTicket({ key: '5' }), makeInventoryTicket({ key: '6' })];
			const result = await plan(makeInput(), ports);
			assert.equal(result.report.parked, null);
		});

		it('parks when a comment-waiting item needs the operator (NEEDS-YOU per design/02)', async () => {
			const ports = new FakePorts();
			ports.tickets.set(
				'5',
				makeTicket({ ticket: '5', health: 'waiting', waitingOn: waiting('comment', minutesAgo(5)) }),
			);
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			const result = await plan(makeInput(), ports);
			assert.match(result.report.parked?.reason ?? '', /1 active items all waiting on you/);
		});

		it('does not park when a worker is in flight', async () => {
			const ports = new FakePorts();
			ports.tickets.set('5', makeTicket({ ticket: '5', health: 'waiting', waitingOn: owner(minutesAgo(5)) }));
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			const result = await plan(makeInput({ liveWorkerKeys: ['5'] }), ports);
			assert.equal(result.report.parked, null);
		});

		it('does not park when work was dispatched', async () => {
			const ports = new FakePorts();
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			const result = await plan(makeInput(), ports);
			assert.equal(result.report.parked, null);
		});

		it('writes orchestrator.json with an incremented passCount and the dispatch/parked/stale fields', async () => {
			const ports = new FakePorts();
			ports.orchestrator = {
				schemaVersion: 1,
				repo: 'acme/app',
				passCount: 7,
				lastPassStartedAt: null,
				lastPassFinishedAt: null,
				staleWorkerMinutes: 30,
				parked: null,
				dispatch: null,
				note: null,
			};
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			const result = await plan(makeInput({ config: { staleWorkerMinutes: 45 } }), ports);
			const written = ports.orchestratorWrites.at(-1);
			assert.equal(written?.passCount, 8);
			assert.equal(written?.staleWorkerMinutes, 45);
			assert.deepEqual(written?.dispatch, result.dispatch);
			assert.equal(written?.parked, null);
		});

		it('stamps lastPassStartedAt at pass start, distinct from the wrap finish time', async () => {
			const ports = new FakePorts();
			ports.labeled = [makeInventoryTicket({ key: '5' })];
			// iso() advances on each read, so the start (first read) precedes finish (wrap).
			let ticks = 0;
			ports.clock = { now: () => NOW, iso: () => new Date(NOW + ++ticks * 1000).toISOString() };
			await plan(makeInput(), ports);
			const written = ports.orchestratorWrites.at(-1);
			assert.ok(written?.lastPassStartedAt && written.lastPassFinishedAt);
			assert.ok(
				Date.parse(written.lastPassStartedAt) < Date.parse(written.lastPassFinishedAt),
				`start ${written.lastPassStartedAt} should precede finish ${written.lastPassFinishedAt}`,
			);
		});
	});
});
