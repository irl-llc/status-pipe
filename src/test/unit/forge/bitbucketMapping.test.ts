/**
 * Unit tests for forge/bitbucketMapping.ts — REST 2.0 responses → forge
 * types. Round-trips the fake-forge renderers plus hand fixtures for state,
 * participants, comment resolution eras, tasks, status aggregation, and
 * Jira key parsing.
 */

import assert from 'node:assert/strict';

import {
	FakePr,
	renderBitbucketComments,
	renderBitbucketPr,
	renderBitbucketStatuses,
	renderBitbucketTasks,
} from '../../../forge/fake/fakeForgeData';
import {
	mapBitbucketComments,
	mapBitbucketPr,
	mapBitbucketStatuses,
	mapBitbucketTasks,
	parseJiraKeys,
} from '../../../forge/bitbucketMapping';
import { Json } from '../../../utils/json';

const SLUG = 'workspace/repo';

function fakePr(overrides: Partial<FakePr> = {}): FakePr {
	return {
		number: 12,
		title: 'PROJ-7: tighten retries',
		state: 'open',
		draft: false,
		head: 'feat/PROJ-7-retries',
		base: 'main',
		updatedAt: '2026-06-02T08:00:00Z',
		prLevelComments: 1,
		threads: [
			{ resolved: true, comments: 2 },
			{ resolved: false, comments: 3 },
		],
		reviewDecision: 'CHANGES_REQUESTED',
		reviewRequests: ['{uuid-1}', '{uuid-2}'],
		checks: [{ name: 'pipeline', status: 'passing', url: 'https://ci.example/9' }],
		linkedTickets: [{ key: 'PROJ-7', title: 'Retries' }],
		tasks: { total: 3, unresolved: 1 },
		...overrides,
	};
}

describe('forge/bitbucketMapping', () => {
	describe('mapBitbucketPr round-trip', () => {
		it('maps every PR field from a rendered response', () => {
			const info = mapBitbucketPr(renderBitbucketPr(fakePr(), SLUG) as Json);
			assert.ok(info);
			assert.equal(info.number, 12);
			assert.equal(info.url, `https://bitbucket.org/${SLUG}/pull-requests/12`);
			assert.equal(info.state, 'open');
			assert.equal(info.draft, false);
			assert.equal(info.title, 'PROJ-7: tighten retries');
			assert.equal(info.headBranch, 'feat/PROJ-7-retries');
			assert.equal(info.baseBranch, 'main');
			assert.equal(info.updatedAt, '2026-06-02T08:00:00Z');
			assert.equal(info.reviewDecision, 'changes-requested');
			assert.deepEqual(info.reviewRequests, ['{uuid-1}', '{uuid-2}']);
		});

		it('returns null without an id', () => {
			assert.equal(mapBitbucketPr({ title: 'no id' }), null);
		});

		const stateCases: Array<[string, string]> = [
			['OPEN', 'open'],
			['MERGED', 'merged'],
			['DECLINED', 'closed'],
			['SUPERSEDED', 'closed'],
		];
		for (const [state, expected] of stateCases) {
			it(`maps state ${state} → ${expected}`, () => {
				assert.equal(mapBitbucketPr({ id: 1, state })?.state, expected);
			});
		}

		it('lets changes_requested win over approved among participants', () => {
			const pr: Json = {
				id: 1,
				participants: [{ state: 'approved' }, { state: 'changes_requested' }, { state: null }],
			};
			assert.equal(mapBitbucketPr(pr)?.reviewDecision, 'changes-requested');
		});

		it('maps approved participants without changes_requested to approved', () => {
			const pr: Json = { id: 1, participants: [{ state: null }, { state: 'approved' }] };
			assert.equal(mapBitbucketPr(pr)?.reviewDecision, 'approved');
		});

		it('maps no participant decision to null', () => {
			assert.equal(mapBitbucketPr({ id: 1, participants: [] })?.reviewDecision, null);
		});

		it('collects reviewer uuids, skipping reviewers without one', () => {
			const pr: Json = { id: 1, reviewers: [{ uuid: '{u1}' }, { name: 'no uuid' }, { uuid: '{u2}' }] };
			assert.deepEqual(mapBitbucketPr(pr)?.reviewRequests, ['{u1}', '{u2}']);
		});
	});

	describe('mapBitbucketComments', () => {
		it('round-trips rendered comments: total, resolvable=inline, unresolved', () => {
			const counts = mapBitbucketComments(renderBitbucketComments(fakePr()));
			// 5 inline (2 resolved + 3 unresolved) + 1 PR-level
			assert.equal(counts.total, 6);
			assert.equal(counts.resolvable, 5);
			assert.equal(counts.unresolved, 3);
			assert.equal(counts.prLevelResolvable, false);
		});

		it('excludes deleted comments', () => {
			const counts = mapBitbucketComments([
				{ id: 1, deleted: true, inline: { path: 'f.ts' } },
				{ id: 2, deleted: false, inline: { path: 'f.ts' } },
				{ id: 3, deleted: true },
			]);
			assert.deepEqual(counts, { total: 1, resolvable: 1, unresolved: 1, prLevelResolvable: false });
		});

		it('treats a resolution object as resolved (current API era)', () => {
			const counts = mapBitbucketComments([{ id: 1, inline: { path: 'f.ts' }, resolution: { type: 'resolved' } }]);
			assert.equal(counts.unresolved, 0);
			assert.equal(counts.resolvable, 1);
		});

		it('treats a resolved boolean as resolved (older API era)', () => {
			const counts = mapBitbucketComments([{ id: 1, inline: { path: 'f.ts' }, resolved: true }]);
			assert.equal(counts.unresolved, 0);
		});

		it('counts an inline comment with neither flag as unresolved', () => {
			const counts = mapBitbucketComments([{ id: 1, inline: { path: 'f.ts' } }]);
			assert.equal(counts.unresolved, 1);
		});

		it('makes only inline comments resolvable; PR-level comments never count', () => {
			const counts = mapBitbucketComments([{ id: 1, inline: { path: 'f.ts' } }, { id: 2 }, { id: 3 }]);
			assert.equal(counts.total, 3);
			assert.equal(counts.resolvable, 1);
			assert.equal(counts.prLevelResolvable, false);
		});
	});

	describe('mapBitbucketTasks', () => {
		it('round-trips rendered tasks', () => {
			assert.deepEqual(mapBitbucketTasks(renderBitbucketTasks(fakePr())), { total: 3, unresolved: 1 });
		});

		it('counts RESOLVED vs anything else', () => {
			const tasks = [{ state: 'RESOLVED' }, { state: 'UNRESOLVED' }, { state: 'UNRESOLVED' }];
			assert.deepEqual(mapBitbucketTasks(tasks), { total: 3, unresolved: 2 });
		});

		it('handles an empty list', () => {
			assert.deepEqual(mapBitbucketTasks([]), { total: 0, unresolved: 0 });
		});
	});

	describe('mapBitbucketStatuses', () => {
		it('round-trips rendered statuses', () => {
			const checks = mapBitbucketStatuses(renderBitbucketStatuses(fakePr()));
			assert.equal(checks.aggregate, 'passing');
			assert.deepEqual(checks.checks, [{ name: 'pipeline', status: 'passing', url: 'https://ci.example/9' }]);
		});

		it('aggregates an empty list to none', () => {
			assert.deepEqual(mapBitbucketStatuses([]), { aggregate: 'none', checks: [] });
		});

		it('lets any FAILED or STOPPED status fail the aggregate', () => {
			const failed = mapBitbucketStatuses([
				{ key: 'a', state: 'SUCCESSFUL' },
				{ key: 'b', state: 'FAILED' },
			]);
			assert.equal(failed.aggregate, 'failing');
			const stopped = mapBitbucketStatuses([
				{ key: 'a', state: 'INPROGRESS' },
				{ key: 'b', state: 'STOPPED' },
			]);
			assert.equal(stopped.aggregate, 'failing');
		});

		it('aggregates any INPROGRESS (without failures) to pending', () => {
			const checks = mapBitbucketStatuses([
				{ key: 'a', state: 'SUCCESSFUL' },
				{ key: 'b', state: 'INPROGRESS' },
			]);
			assert.equal(checks.aggregate, 'pending');
		});

		it('aggregates all SUCCESSFUL to passing', () => {
			const checks = mapBitbucketStatuses([
				{ key: 'a', state: 'SUCCESSFUL' },
				{ key: 'b', state: 'SUCCESSFUL' },
			]);
			assert.equal(checks.aggregate, 'passing');
		});

		it('falls back name → key → build', () => {
			const checks = mapBitbucketStatuses([{ key: 'k', state: 'SUCCESSFUL' }, { state: 'SUCCESSFUL' }]);
			assert.deepEqual(
				checks.checks.map((c) => c.name),
				['k', 'build'],
			);
		});
	});

	describe('parseJiraKeys', () => {
		const pr: Json = {
			source: { branch: { name: 'feat/PROJ-12-retries' } },
			title: 'PROJ-12: also see ABC-9',
			summary: { raw: 'Relates to XYZ-100 and PROJ-12 again' },
		};

		it('parses unique keys from branch, title, and summary.raw', () => {
			const refs = parseJiraKeys(pr, null);
			assert.deepEqual(
				refs.map((r) => r.key),
				['PROJ-12', 'ABC-9', 'XYZ-100'],
			);
		});

		it('builds browse URLs from the Jira site URL, stripping a trailing slash', () => {
			const refs = parseJiraKeys(pr, 'https://org.atlassian.net/');
			assert.equal(refs[0].url, 'https://org.atlassian.net/browse/PROJ-12');
		});

		it('degrades to empty URLs without a Jira site URL', () => {
			for (const ref of parseJiraKeys(pr, null)) assert.equal(ref.url, '');
		});

		it('round-trips keys rendered into the fake summary', () => {
			const refs = parseJiraKeys(renderBitbucketPr(fakePr(), SLUG) as Json, 'https://org.atlassian.net');
			assert.deepEqual(refs.map((r) => r.key).includes('PROJ-7'), true);
		});

		it('ignores lowercase lookalikes and bare words', () => {
			const refs = parseJiraKeys({ title: 'proj-12 fix-3 a PROJ12' }, null);
			assert.deepEqual(refs, []);
		});

		it('reads a plain description when summary.raw is absent', () => {
			const refs = parseJiraKeys({ description: 'covers DESC-4' }, null);
			assert.deepEqual(
				refs.map((r) => r.key),
				['DESC-4'],
			);
		});
	});
});
