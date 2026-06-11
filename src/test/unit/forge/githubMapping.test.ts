/**
 * Unit tests for forge/githubMapping.ts — GraphQL node → forge types.
 * Round-trips the fake-forge renderer (FakePr → renderGithubPrNode → map*)
 * plus hand-written edge fixtures for caps, decisions, and check shapes.
 */

import assert from 'node:assert/strict';

import { FakePr, renderGithubPrNode } from '../../../forge/fake/fakeForgeData';
import { mapGithubChecks, mapGithubComments, mapGithubLinkedTickets, mapGithubPr } from '../../../forge/githubMapping';
import { Json } from '../../../utils/json';

const SLUG = 'owner/repo';

function fakePr(overrides: Partial<FakePr> = {}): FakePr {
	return {
		number: 7,
		title: 'Add rate limiting',
		state: 'open',
		draft: false,
		head: 'feat/rate-limit',
		base: 'main',
		updatedAt: '2026-06-01T12:00:00Z',
		prLevelComments: 2,
		threads: [
			{ resolved: true, comments: 3 },
			{ resolved: false, comments: 2 },
		],
		reviewDecision: 'APPROVED',
		reviewRequests: ['alice'],
		checks: [{ name: 'ci', status: 'passing', url: 'https://ci.example/1' }],
		linkedTickets: [{ key: '42', title: 'Rate limit epic' }],
		...overrides,
	};
}

describe('forge/githubMapping', () => {
	describe('mapGithubPr round-trip', () => {
		it('maps every PR field from a rendered node', () => {
			const info = mapGithubPr(renderGithubPrNode(fakePr(), SLUG) as Json);
			assert.ok(info);
			assert.equal(info.number, 7);
			assert.equal(info.url, `https://github.com/${SLUG}/pull/7`);
			assert.equal(info.state, 'open');
			assert.equal(info.draft, false);
			assert.equal(info.title, 'Add rate limiting');
			assert.equal(info.headBranch, 'feat/rate-limit');
			assert.equal(info.baseBranch, 'main');
			assert.equal(info.updatedAt, '2026-06-01T12:00:00Z');
			assert.equal(info.reviewDecision, 'approved');
			assert.deepEqual(info.reviewRequests, ['alice']);
		});

		it('maps MERGED and CLOSED states', () => {
			const merged = mapGithubPr(renderGithubPrNode(fakePr({ state: 'merged' }), SLUG) as Json);
			const closed = mapGithubPr(renderGithubPrNode(fakePr({ state: 'closed' }), SLUG) as Json);
			assert.equal(merged?.state, 'merged');
			assert.equal(closed?.state, 'closed');
		});

		it('returns null without a number', () => {
			assert.equal(mapGithubPr({ title: 'no number' }), null);
		});
	});

	describe('mapGithubComments', () => {
		it('totals PR-level + per-thread comments and counts unresolved threads', () => {
			const counts = mapGithubComments(renderGithubPrNode(fakePr(), SLUG) as Json);
			// total = prLevel (2) + Σ thread comments (3 + 2)
			assert.equal(counts.total, 7);
			assert.equal(counts.resolvable, 2);
			assert.equal(counts.unresolved, 1);
			assert.equal(counts.prLevelResolvable, false);
			assert.equal(counts.capped, false);
		});

		it('marks capped when reviewThreads.totalCount exceeds the 100-thread cap', () => {
			const node: Json = {
				comments: { totalCount: 1 },
				reviewThreads: {
					totalCount: 150,
					nodes: [{ isResolved: false, comments: { totalCount: 4 } }],
				},
			};
			const counts = mapGithubComments(node);
			assert.equal(counts.capped, true);
			assert.equal(counts.resolvable, 150);
			assert.equal(counts.total, 5);
			assert.equal(counts.unresolved, 1);
		});

		it('does not cap at exactly 100 threads', () => {
			const node: Json = { comments: { totalCount: 0 }, reviewThreads: { totalCount: 100, nodes: [] } };
			assert.equal(mapGithubComments(node).capped, false);
		});

		it('degrades to zeros on a missing shape', () => {
			assert.deepEqual(mapGithubComments({}), {
				total: 0,
				resolvable: 0,
				unresolved: 0,
				prLevelResolvable: false,
				capped: false,
			});
		});
	});

	describe('review decision mapping', () => {
		const cases: Array<[FakePr['reviewDecision'], string | null]> = [
			['APPROVED', 'approved'],
			['CHANGES_REQUESTED', 'changes-requested'],
			['REVIEW_REQUIRED', 'review-required'],
			[null, null],
		];
		for (const [input, expected] of cases) {
			it(`maps ${String(input)} → ${String(expected)}`, () => {
				const info = mapGithubPr(renderGithubPrNode(fakePr({ reviewDecision: input }), SLUG) as Json);
				assert.equal(info?.reviewDecision, expected);
			});
		}
	});

	describe('review requests', () => {
		it('reads User.login and Team.slug, skipping unknown reviewers', () => {
			const node: Json = {
				number: 1,
				reviewRequests: {
					nodes: [
						{ requestedReviewer: { login: 'alice' } },
						{ requestedReviewer: { slug: 'platform-team' } },
						{ requestedReviewer: {} },
						{},
					],
				},
			};
			assert.deepEqual(mapGithubPr(node)?.reviewRequests, ['alice', 'platform-team']);
		});
	});

	describe('mapGithubChecks', () => {
		it('round-trips a rendered rollup', () => {
			const checks = mapGithubChecks(renderGithubPrNode(fakePr(), SLUG) as Json);
			assert.equal(checks.aggregate, 'passing');
			assert.deepEqual(checks.checks, [{ name: 'ci', status: 'passing', url: 'https://ci.example/1' }]);
		});

		it('round-trips failing and pending fake checks into the aggregate', () => {
			const failing = mapGithubChecks(
				renderGithubPrNode(fakePr({ checks: [{ name: 'ci', status: 'failing' }] }), SLUG) as Json,
			);
			assert.equal(failing.aggregate, 'failing');
			const pending = mapGithubChecks(
				renderGithubPrNode(fakePr({ checks: [{ name: 'ci', status: 'pending' }] }), SLUG) as Json,
			);
			assert.equal(pending.aggregate, 'pending');
			assert.deepEqual(
				pending.checks.map((c) => c.status),
				['pending'],
			);
		});

		it('maps a null rollup (no checks) to none', () => {
			const node = renderGithubPrNode(fakePr({ checks: [] }), SLUG) as Json;
			assert.deepEqual(mapGithubChecks(node), { aggregate: 'none', checks: [] });
		});

		function rollupNode(state: string | null, contexts: unknown[] = []): Json {
			return { commits: { nodes: [{ commit: { statusCheckRollup: { state, contexts: { nodes: contexts } } } }] } };
		}

		const rollupCases: Array<[string, string]> = [
			['SUCCESS', 'passing'],
			['FAILURE', 'failing'],
			['ERROR', 'failing'],
			['PENDING', 'pending'],
			['EXPECTED', 'pending'],
		];
		for (const [state, aggregate] of rollupCases) {
			it(`maps rollup state ${state} → ${aggregate}`, () => {
				assert.equal(mapGithubChecks(rollupNode(state)).aggregate, aggregate);
			});
		}

		it('maps an unknown rollup state to none', () => {
			assert.equal(mapGithubChecks(rollupNode(null)).aggregate, 'none');
		});

		const runCases: Array<[string, string | null, string]> = [
			['COMPLETED', 'SUCCESS', 'passing'],
			['COMPLETED', 'SKIPPED', 'skipped'],
			['COMPLETED', 'NEUTRAL', 'skipped'],
			['COMPLETED', 'FAILURE', 'failing'],
			['IN_PROGRESS', null, 'pending'],
		];
		for (const [status, conclusion, expected] of runCases) {
			it(`maps CheckRun ${status}/${String(conclusion)} → ${expected}`, () => {
				const node = rollupNode('SUCCESS', [{ name: 'job', status, conclusion, detailsUrl: 'https://x/1' }]);
				assert.deepEqual(mapGithubChecks(node).checks, [{ name: 'job', status: expected, url: 'https://x/1' }]);
			});
		}

		const contextCases: Array<[string, string]> = [
			['SUCCESS', 'passing'],
			['PENDING', 'pending'],
			['FAILURE', 'failing'],
			['ERROR', 'failing'],
		];
		for (const [state, expected] of contextCases) {
			it(`maps StatusContext ${state} → ${expected}`, () => {
				const node = rollupNode('SUCCESS', [{ context: 'legacy/ci', state, targetUrl: 'https://x/2' }]);
				assert.deepEqual(mapGithubChecks(node).checks, [{ name: 'legacy/ci', status: expected, url: 'https://x/2' }]);
			});
		}

		it('drops context nodes that are neither CheckRun nor StatusContext', () => {
			const node = rollupNode('SUCCESS', [{ unexpected: true }]);
			assert.deepEqual(mapGithubChecks(node).checks, []);
		});
	});

	describe('mapGithubLinkedTickets', () => {
		it('round-trips closing issue references with keys as strings', () => {
			const tickets = mapGithubLinkedTickets(renderGithubPrNode(fakePr(), SLUG) as Json);
			assert.deepEqual(tickets, [{ key: '42', title: 'Rate limit epic', url: `https://github.com/${SLUG}/issues/42` }]);
		});

		it('stringifies issue numbers and skips nodes without one', () => {
			const node: Json = {
				closingIssuesReferences: {
					nodes: [{ number: 91, title: 'a', url: 'https://x/91' }, { title: 'no number' }, null],
				},
			};
			const tickets = mapGithubLinkedTickets(node);
			assert.deepEqual(tickets, [{ key: '91', title: 'a', url: 'https://x/91' }]);
			assert.equal(typeof tickets[0].key, 'string');
		});

		it('returns empty for a missing shape', () => {
			assert.deepEqual(mapGithubLinkedTickets({}), []);
		});
	});
});
