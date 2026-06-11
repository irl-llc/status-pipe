/**
 * Cache-policy tests for forge/enricher.ts (design/06): every scenario's
 * assertion is "N requests for this scenario", counted on a fake
 * ForgeRepository, with an injected manual clock/scheduler.
 */

import assert from 'node:assert/strict';

import { ForgeEnricher } from '../../../forge/enricher';
import {
	ChecksInfo,
	Forge,
	ForgeError,
	ForgeRepository,
	PullRequestInfo,
	RepositoryId,
	TicketRef,
} from '../../../forge/types';
import { flushMicrotasks, ManualClock } from '../helpers/manualClock';

const REPO = '/work/repo';

const FAKE_FORGE: Forge = {
	id: 'fake',
	baseUrl: 'https://fake.example',
	capabilities: { tasks: false, threadResolution: true, ticketLinks: 'none' },
	matchRemoteUrl: () => null,
	openRepository: () => {
		throw new Error('unused');
	},
};

const FAKE_ID: RepositoryId = {
	forgeId: 'fake',
	slug: 'o/r',
	prUrl: (n: number) => `https://fake.example/o/r/pull/${n}`,
};

function prInfo(number: number, state: PullRequestInfo['state']): PullRequestInfo {
	return {
		number,
		url: `https://fake.example/o/r/pull/${number}`,
		state,
		draft: false,
		title: `PR ${number}`,
		headBranch: `feat-${number}`,
		baseBranch: 'main',
		comments: { total: 0, resolvable: 0, unresolved: 0, prLevelResolvable: false },
		updatedAt: '2026-06-01T00:00:00Z',
	};
}

class FakeRepository implements ForgeRepository {
	readonly forge = FAKE_FORGE;
	readonly id = FAKE_ID;
	readonly prCalls: number[][] = [];
	readonly checksCalls: number[] = [];
	readonly ticketCalls: number[] = [];
	/** PR states served; defaults to open. */
	readonly states = new Map<number, PullRequestInfo['state']>();
	/** When set, the next getPullRequests throws it (once). */
	failNext: ForgeError | null = null;
	/** When true, getPullRequests stalls until release() is called. */
	deferNext = false;
	private releaseDeferred: (() => void) | null = null;

	async getPullRequests(numbers: number[]): Promise<PullRequestInfo[]> {
		this.prCalls.push([...numbers]);
		if (this.failNext) {
			const err = this.failNext;
			this.failNext = null;
			throw err;
		}
		if (this.deferNext) {
			this.deferNext = false;
			await new Promise<void>((resolve) => {
				this.releaseDeferred = resolve;
			});
		}
		return numbers.map((n) => prInfo(n, this.states.get(n) ?? 'open'));
	}

	release(): void {
		this.releaseDeferred?.();
		this.releaseDeferred = null;
	}

	async getChecks(prNumber: number): Promise<ChecksInfo> {
		this.checksCalls.push(prNumber);
		return { aggregate: 'passing', checks: [] };
	}

	async getLinkedTickets(prNumber: number): Promise<TicketRef[]> {
		this.ticketCalls.push(prNumber);
		return [];
	}

	async getViewerLogin(): Promise<string | null> {
		return 'viewer';
	}
}

interface Harness {
	clock: ManualClock;
	repo: FakeRepository;
	enricher: ForgeEnricher;
	updates: string[];
}

function makeHarness(): Harness {
	const clock = new ManualClock();
	clock.now = 1_000_000;
	const repo = new FakeRepository();
	const updates: string[] = [];
	const enricher = new ForgeEnricher(
		{ now: () => clock.now, schedule: clock.schedule, onUpdate: (repoRoot) => updates.push(repoRoot) },
		{ refreshIntervalSeconds: 60 },
	);
	enricher.setRepository(REPO, repo);
	return { clock, repo, enricher, updates };
}

describe('forge/enricher', () => {
	describe('terminal-state freeze', () => {
		it('fetches merged PRs once, then only the open one', async () => {
			const { repo, enricher } = makeHarness();
			repo.states.set(2, 'merged');
			enricher.setTrackedPrs(REPO, [
				{ number: 1, state: 'open' },
				{ number: 2, state: 'merged' },
			]);

			enricher.forceRefresh(REPO);
			await flushMicrotasks();
			// First refresh fetches BOTH, in one batch.
			assert.deepEqual(repo.prCalls, [[1, 2]]);

			enricher.forceRefresh(REPO);
			await flushMicrotasks();
			// The merged PR is now cached terminal — frozen forever.
			assert.deepEqual(repo.prCalls, [[1, 2], [1]]);

			enricher.forceRefresh(REPO);
			await flushMicrotasks();
			assert.deepEqual(repo.prCalls, [[1, 2], [1], [1]]);
		});
	});

	describe('change-driven narrowing', () => {
		it('fetches only the changed PR after the 5s coalesce window', async () => {
			const { clock, repo, enricher } = makeHarness();
			enricher.setTrackedPrs(REPO, [
				{ number: 5, state: 'open' },
				{ number: 6, state: 'open' },
			]);
			enricher.forceRefresh(REPO);
			await flushMicrotasks();
			assert.deepEqual(repo.prCalls, [[5, 6]]);

			enricher.noteTicketsChanged(REPO, [5]);
			await clock.advance(5_000);
			assert.deepEqual(repo.prCalls, [[5, 6], [5]]);
		});

		it('includes tracked-but-uncached PRs in a changed-scope fetch', async () => {
			const { clock, repo, enricher } = makeHarness();
			enricher.setTrackedPrs(REPO, [
				{ number: 5, state: 'open' },
				{ number: 6, state: 'open' },
			]);
			enricher.noteTicketsChanged(REPO, [5]);
			await clock.advance(5_000);
			assert.deepEqual(repo.prCalls, [[5, 6]]);
		});

		it('coalesces a second change within the window into one fetch', async () => {
			const { clock, repo, enricher } = makeHarness();
			enricher.setTrackedPrs(REPO, [
				{ number: 5, state: 'open' },
				{ number: 6, state: 'open' },
			]);
			enricher.forceRefresh(REPO);
			await flushMicrotasks();

			enricher.noteTicketsChanged(REPO, [5]);
			await clock.advance(2_000);
			enricher.noteTicketsChanged(REPO, [6]);
			await clock.advance(3_000);
			// One coalesced fetch covering both, 5s after the FIRST change.
			assert.deepEqual(repo.prCalls, [
				[5, 6],
				[5, 6],
			]);

			await clock.advance(10_000);
			assert.equal(repo.prCalls.length, 2);
		});
	});

	describe('visible-only polling', () => {
		it('polls every interval while visible and stops when hidden', async () => {
			const { clock, repo, enricher } = makeHarness();
			enricher.setTrackedPrs(REPO, [{ number: 1, state: 'open' }]);

			enricher.setVisible(true);
			assert.equal(repo.prCalls.length, 0);

			await clock.advance(60_000);
			assert.equal(repo.prCalls.length, 1);

			await clock.advance(60_000);
			assert.equal(repo.prCalls.length, 2);

			enricher.setVisible(false);
			await clock.advance(300_000);
			assert.equal(repo.prCalls.length, 2);
		});
	});

	describe('focus refresh', () => {
		it('refetches on focus only when the cache is older than the min interval', async () => {
			const { clock, repo, enricher } = makeHarness();
			enricher.setTrackedPrs(REPO, [{ number: 1, state: 'open' }]);
			enricher.forceRefresh(REPO);
			await flushMicrotasks();
			assert.equal(repo.prCalls.length, 1);

			enricher.onFocusRegained();
			await flushMicrotasks();
			// Fresh data — focus does not refetch.
			assert.equal(repo.prCalls.length, 1);

			await clock.advance(60_000);
			enricher.onFocusRegained();
			await flushMicrotasks();
			assert.equal(repo.prCalls.length, 2);
		});
	});

	describe('backoff', () => {
		it('degrades on rate-limit, blocks refreshes until the backoff passes', async () => {
			const { clock, repo, enricher } = makeHarness();
			enricher.setTrackedPrs(REPO, [{ number: 1, state: 'open' }]);
			const retryAfter = clock.now + 300_000;
			repo.failNext = new ForgeError('rate-limit', 'slow down', retryAfter);

			enricher.forceRefresh(REPO);
			await flushMicrotasks();
			assert.equal(repo.prCalls.length, 1);
			assert.equal(enricher.activity().state, 'degraded');
			assert.match(enricher.activity().detail ?? '', /rate-limit: slow down/);

			// During backoff even a force refresh sends nothing.
			enricher.forceRefresh(REPO);
			await flushMicrotasks();
			assert.equal(repo.prCalls.length, 1);

			await clock.advance(300_001);
			enricher.forceRefresh(REPO);
			await flushMicrotasks();
			assert.equal(repo.prCalls.length, 2);
			assert.equal(enricher.activity().state, 'idle');
		});
	});

	describe('persistence round-trip', () => {
		it('serialize() → load() serves enrichment without any fetch', async () => {
			const { enricher, repo } = makeHarness();
			enricher.setTrackedPrs(REPO, [{ number: 1, state: 'open' }]);
			enricher.forceRefresh(REPO);
			await flushMicrotasks();
			const persisted = enricher.serialize();

			const clock = new ManualClock();
			const freshRepo = new FakeRepository();
			const fresh = new ForgeEnricher(
				{ now: () => clock.now, schedule: clock.schedule, onUpdate: () => undefined },
				{ refreshIntervalSeconds: 60 },
			);
			fresh.setRepository(REPO, freshRepo);
			fresh.load(persisted);

			const enrichment = fresh.getEnrichment(REPO);
			assert.ok(enrichment);
			assert.equal(enrichment.prs[1].info?.number, 1);
			assert.equal(enrichment.viewerLogin, 'viewer');
			assert.equal(freshRepo.prCalls.length, 0);
			assert.equal(repo.prCalls.length, 1);
		});
	});

	describe('fetching flag', () => {
		it("activity() is 'refreshing' while a fetch is in flight", async () => {
			const { repo, enricher } = makeHarness();
			enricher.setTrackedPrs(REPO, [{ number: 1, state: 'open' }]);
			repo.deferNext = true;

			enricher.forceRefresh(REPO);
			await flushMicrotasks();
			assert.equal(enricher.activity().state, 'refreshing');

			repo.release();
			await flushMicrotasks();
			assert.equal(enricher.activity().state, 'idle');
			assert.equal(repo.prCalls.length, 1);
		});
	});
});
