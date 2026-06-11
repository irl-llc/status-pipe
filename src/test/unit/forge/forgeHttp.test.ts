/**
 * HTTP-layer forge tests against the in-process FakeForgeServer — the layer
 * the FakeRepository-based enricher tests cannot see. These pin the
 * rate-budget invariants of design/03 where they actually live:
 *
 *  - GitHub: ONE aliased GraphQL POST per refresh covers every tracked PR,
 *    checks, linked tickets, and the viewer — request count is the contract.
 *  - Bitbucket: N+1 by nature, so every GET sends If-None-Match and 304s
 *    serve from the ETag cache; list endpoints follow `next` pagination;
 *    the request pool never exceeds 4 in flight.
 */

import assert from 'node:assert/strict';

import { BitbucketForge } from '../../../forge/bitbucket';
import { FakePr, FakeRepoData } from '../../../forge/fake/fakeForgeData';
import { FakeForgeServer } from '../../../forge/fake/fakeForgeServer';
import { GithubForge } from '../../../forge/github';
import { RequestPool, fetchHttpClient } from '../../../forge/http';

function fakePr(number: number, overrides: Partial<FakePr> = {}): FakePr {
	return {
		number,
		title: `PR ${number}`,
		state: 'open',
		draft: false,
		head: `feat-${number}`,
		base: 'main',
		updatedAt: '2026-06-11T08:00:00Z',
		prLevelComments: 1,
		threads: [{ resolved: false, comments: 2 }],
		reviewDecision: 'CHANGES_REQUESTED',
		reviewRequests: ['ed'],
		checks: [{ name: 'build', status: 'failing', url: 'https://ci.example/run/1' }],
		linkedTickets: [{ key: '853', title: 'Rotate keys' }],
		tasks: { total: 3, unresolved: 1 },
		...overrides,
	};
}

function repoData(prs: FakePr[]): FakeRepoData {
	return { slug: 'acme/x', viewerLogin: 'ed', prs };
}

describe('forge/HTTP layer (FakeForgeServer)', () => {
	let server: FakeForgeServer;
	let baseUrl: string;

	afterEach(async () => {
		await server.stop();
	});

	describe('GitHub batching', () => {
		it('covers PRs, checks, tickets, and viewer with exactly ONE GraphQL request per refresh', async () => {
			server = new FakeForgeServer(repoData([fakePr(855), fakePr(861)]));
			baseUrl = await server.start();
			const forge = new GithubForge({ apiUrl: baseUrl, http: fetchHttpClient });
			const repo = forge.openRepository(forge.repositoryId('acme/x'), { token: 't' });

			const prs = await repo.getPullRequests([855, 861]);
			assert.equal(prs.length, 2);
			assert.equal(server.requestCount, 1, `expected one batched POST, saw: ${server.requestLog.join(', ')}`);

			// Checks, linked tickets, and viewer ride the same response.
			const checks = await repo.getChecks(855);
			assert.equal(checks.aggregate, 'failing');
			const tickets = await repo.getLinkedTickets(855);
			assert.equal(tickets[0]?.key, '853');
			assert.equal(await repo.getViewerLogin(), 'ed');
			assert.equal(server.requestCount, 1, 'follow-up reads must not add HTTP requests');
		});

		it('a second refresh is a second single request — cost scales with refreshes, not PRs', async () => {
			server = new FakeForgeServer(repoData([fakePr(1), fakePr(2), fakePr(3), fakePr(4), fakePr(5)]));
			baseUrl = await server.start();
			const forge = new GithubForge({ apiUrl: baseUrl, http: fetchHttpClient });
			const repo = forge.openRepository(forge.repositoryId('acme/x'), { token: 't' });

			await repo.getPullRequests([1, 2, 3, 4, 5]);
			await repo.getPullRequests([1, 2, 3, 4, 5]);
			assert.equal(server.requestCount, 2);
		});
	});

	describe('Bitbucket ETag cache', () => {
		it('sends If-None-Match on re-fetch and serves identical data from 304s', async () => {
			server = new FakeForgeServer(repoData([fakePr(7)]));
			baseUrl = await server.start();
			const forge = new BitbucketForge({ apiUrl: baseUrl, http: fetchHttpClient });
			const repo = forge.openRepository(forge.repositoryId('acme/x'), { token: 't' });

			const first = await repo.getPullRequests([7]);
			assert.equal(first.length, 1);
			assert.equal(server.notModifiedCount, 0);
			const coldRequests = server.requestCount;
			assert.ok(coldRequests >= 3, 'PR + comments + tasks');

			const second = await repo.getPullRequests([7]);
			assert.deepEqual(second, first, '304s must reconstruct the same mapped data');
			assert.equal(server.notModifiedCount, coldRequests, 'every warm GET should be a 304');
		});

		it('treats a 404 as deleted-on-forge (row dropped), not a failure', async () => {
			server = new FakeForgeServer(repoData([fakePr(7)]));
			baseUrl = await server.start();
			const forge = new BitbucketForge({ apiUrl: baseUrl, http: fetchHttpClient });
			const repo = forge.openRepository(forge.repositoryId('acme/x'), { token: 't' });
			const prs = await repo.getPullRequests([7, 999]);
			assert.deepEqual(
				prs.map((p) => p.number),
				[7],
			);
		});
	});

	describe('Bitbucket pagination', () => {
		it('follows `next` links across pages and aggregates all values', async () => {
			// 130 unresolved threads → comments paginate at pagelen=100 → 2 pages.
			const threads = Array.from({ length: 130 }, () => ({ resolved: false, comments: 1 }));
			server = new FakeForgeServer(repoData([fakePr(7, { threads, prLevelComments: 0 })]));
			baseUrl = await server.start();
			const forge = new BitbucketForge({ apiUrl: baseUrl, http: fetchHttpClient });
			const repo = forge.openRepository(forge.repositoryId('acme/x'), { token: 't' });

			const [pr] = await repo.getPullRequests([7]);
			assert.ok(pr.comments);
			assert.equal(pr.comments.total, 130);
			const commentPages = server.requestLog.filter((l) => l.includes('/comments')).length;
			assert.equal(commentPages, 2, `expected 2 comment pages, log: ${server.requestLog.join(', ')}`);
		});
	});
});

describe('forge/RequestPool', () => {
	it('never runs more than the limit concurrently and completes everything', async () => {
		const pool = new RequestPool(4);
		let active = 0;
		let highWater = 0;
		const tasks = Array.from({ length: 12 }, (_, i) =>
			pool.run(async () => {
				active += 1;
				highWater = Math.max(highWater, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active -= 1;
				return i;
			}),
		);
		const results = await Promise.all(tasks);
		assert.equal(results.length, 12);
		assert.ok(highWater <= 4, `high-water mark ${highWater} exceeded the pool limit`);
		assert.ok(highWater >= 2, 'tasks should actually overlap');
	});
});
