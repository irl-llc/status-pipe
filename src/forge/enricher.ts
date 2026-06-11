/**
 * Forge enrichment orchestration (design/03-forge.md, 04-architecture.md):
 * change-driven fetching, visible-view-only polling, terminal-state freeze,
 * rate-budget stretching, per-repo backoff. vscode-free — the host wires
 * watchers/visibility in; tests inject a clock and count requests.
 */

import { ActivityDisplay } from '../queue/displayTypes';
import { PrEnrichment, RepoEnrichment } from '../queue/queueInputs';
import { BackoffState, NO_BACKOFF, backoffActive, nextBackoff, stretchFactor } from './budget';
import { RateInfo } from './http';
import { ForgeError, ForgeRepository } from './types';

const CHANGE_COALESCE_MS = 5_000;

export interface EnricherDeps {
	now(): number;
	/** setTimeout-shaped; returns a cancel function. */
	schedule(fn: () => void, ms: number): () => void;
	/** Enrichment overlay for repoRoot changed — rebuild DisplayState. */
	onUpdate(repoRoot: string): void;
}

export interface EnricherSettings {
	refreshIntervalSeconds: number;
}

export interface TrackedPr {
	number: number;
	/** The worker's cached view — pre-freezes PRs already known terminal. */
	state: 'open' | 'merged' | 'closed';
}

interface RepoEntry {
	repository: ForgeRepository | null;
	tracked: Map<number, TrackedPr['state']>;
	prs: Map<number, PrEnrichment>;
	viewerLogin: string | null;
	pendingChanged: Set<number>;
	cancelCoalesce: (() => void) | null;
	backoff: BackoffState;
	rate: RateInfo | null;
	lastRefreshAt: number;
	fetching: boolean;
	lastError: string | null;
}

export type PersistedEnrichment = Record<string, { prs: Record<number, PrEnrichment>; viewerLogin: string | null }>;

export class ForgeEnricher {
	private readonly repos = new Map<string, RepoEntry>();
	private visible = false;
	private cancelPoll: (() => void) | null = null;

	constructor(
		private readonly deps: EnricherDeps,
		private readonly settings: EnricherSettings,
	) {}

	dispose(): void {
		this.cancelPoll?.();
		for (const entry of this.repos.values()) entry.cancelCoalesce?.();
	}

	private entry(repoRoot: string): RepoEntry {
		let entry = this.repos.get(repoRoot);
		if (!entry) {
			entry = {
				repository: null,
				tracked: new Map(),
				prs: new Map(),
				viewerLogin: null,
				pendingChanged: new Set(),
				cancelCoalesce: null,
				backoff: NO_BACKOFF,
				rate: null,
				lastRefreshAt: 0,
				fetching: false,
				lastError: null,
			};
			this.repos.set(repoRoot, entry);
		}
		return entry;
	}

	setRepository(repoRoot: string, repository: ForgeRepository | null): void {
		this.entry(repoRoot).repository = repository;
	}

	noteRateInfo(repoRoot: string, rate: RateInfo): void {
		this.entry(repoRoot).rate = rate;
	}

	/** Tracked PRs from the protocol store (all tickets' prs[] in the repo). */
	setTrackedPrs(repoRoot: string, prs: TrackedPr[]): void {
		const entry = this.entry(repoRoot);
		entry.tracked = new Map(prs.map((p) => [p.number, p.state]));
	}

	getEnrichment(repoRoot: string): RepoEnrichment | null {
		const entry = this.repos.get(repoRoot);
		if (!entry || entry.prs.size === 0) return null;
		return { prs: Object.fromEntries(entry.prs), viewerLogin: entry.viewerLogin };
	}

	/** Change-driven trigger: coalesced 5s, then fetch only affected PRs. */
	noteTicketsChanged(repoRoot: string, changedPrs: number[]): void {
		const entry = this.entry(repoRoot);
		changedPrs.forEach((n) => entry.pendingChanged.add(n));
		if (entry.cancelCoalesce) return;
		entry.cancelCoalesce = this.deps.schedule(() => {
			entry.cancelCoalesce = null;
			const changed = [...entry.pendingChanged];
			entry.pendingChanged.clear();
			void this.refreshRepo(repoRoot, { scope: 'changed', changed });
		}, CHANGE_COALESCE_MS);
	}

	/** Hidden views don't poll; visibility starts the periodic loop. */
	setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible && !this.cancelPoll) this.schedulePoll();
		if (!visible) {
			this.cancelPoll?.();
			this.cancelPoll = null;
		}
	}

	onFocusRegained(): void {
		const minIntervalMs = this.settings.refreshIntervalSeconds * 1000;
		for (const repoRoot of this.repos.keys()) {
			if (this.deps.now() - this.entry(repoRoot).lastRefreshAt >= minIntervalMs) {
				void this.refreshRepo(repoRoot, { scope: 'all' });
			}
		}
	}

	/** Bypasses min-interval and narrowing, still respects an active backoff. */
	forceRefresh(repoRoot?: string): void {
		const targets = repoRoot ? [repoRoot] : [...this.repos.keys()];
		for (const target of targets) void this.refreshRepo(target, { scope: 'all', force: true });
	}

	activity(): ActivityDisplay {
		const entries = [...this.repos.values()];
		if (entries.some((e) => e.fetching)) {
			return { state: 'refreshing', detail: null, oldestDataAgeMs: this.oldestDataAgeMs() };
		}
		const degraded = entries.find((e) => e.lastError !== null || backoffActive(e.backoff, this.deps.now()));
		if (degraded) {
			return { state: 'degraded', detail: this.degradedDetail(degraded), oldestDataAgeMs: this.oldestDataAgeMs() };
		}
		return { state: 'idle', detail: null, oldestDataAgeMs: this.oldestDataAgeMs() };
	}

	serialize(): PersistedEnrichment {
		const out: PersistedEnrichment = {};
		for (const [repoRoot, entry] of this.repos) {
			out[repoRoot] = { prs: Object.fromEntries(entry.prs), viewerLogin: entry.viewerLogin };
		}
		return out;
	}

	/** Reload yesterday's data so a window reload never causes a request storm. */
	load(persisted: PersistedEnrichment): void {
		for (const [repoRoot, data] of Object.entries(persisted)) {
			const entry = this.entry(repoRoot);
			entry.prs = new Map(Object.entries(data.prs).map(([k, v]) => [Number(k), v]));
			entry.viewerLogin = data.viewerLogin;
		}
	}

	private schedulePoll(): void {
		this.cancelPoll = this.deps.schedule(() => {
			this.cancelPoll = null;
			if (!this.visible) return;
			this.pollTick();
			this.schedulePoll();
		}, this.settings.refreshIntervalSeconds * 1000);
	}

	private pollTick(): void {
		for (const [repoRoot, entry] of this.repos) {
			const interval = this.settings.refreshIntervalSeconds * 1000 * stretchFactor(entry.rate, this.deps.now());
			if (this.deps.now() - entry.lastRefreshAt >= interval) {
				void this.refreshRepo(repoRoot, { scope: 'all' });
			}
		}
	}

	private numbersToFetch(entry: RepoEntry, options: RefreshOptions): number[] {
		const frozen = (n: number): boolean => {
			// Terminal-state freeze: merged/closed PRs are immutable for us.
			const cached = entry.prs.get(n)?.info?.state;
			if (cached === 'merged' || cached === 'closed') return true;
			const workerView = entry.tracked.get(n);
			return (workerView === 'merged' || workerView === 'closed') && entry.prs.has(n);
		};
		const all = [...entry.tracked.keys()].filter((n) => !frozen(n));
		if (options.scope === 'all') return all;
		const missing = all.filter((n) => !entry.prs.has(n));
		return [...new Set([...(options.changed ?? []).filter((n) => !frozen(n)), ...missing])];
	}

	private async refreshRepo(repoRoot: string, options: RefreshOptions): Promise<void> {
		const entry = this.entry(repoRoot);
		if (!entry.repository || entry.fetching) return;
		if (backoffActive(entry.backoff, this.deps.now())) return;
		const numbers = this.numbersToFetch(entry, options);
		if (numbers.length === 0) return;
		entry.fetching = true;
		this.deps.onUpdate(repoRoot);
		try {
			await this.fetchInto(entry, numbers);
			entry.backoff = NO_BACKOFF;
			entry.lastError = null;
			if (options.scope === 'all') entry.lastRefreshAt = this.deps.now();
		} catch (err) {
			this.recordFailure(entry, err);
		} finally {
			entry.fetching = false;
			this.deps.onUpdate(repoRoot);
		}
	}

	private async fetchInto(entry: RepoEntry, numbers: number[]): Promise<void> {
		const repository = entry.repository!;
		const infos = await repository.getPullRequests(numbers);
		const byNumber = new Map(infos.map((i) => [i.number, i]));
		for (const n of numbers) {
			entry.prs.set(n, await this.buildEnrichment(repository, byNumber.get(n) ?? null, n));
		}
		entry.viewerLogin = (await repository.getViewerLogin()) ?? entry.viewerLogin;
	}

	private async buildEnrichment(
		repository: ForgeRepository,
		info: import('./types').PullRequestInfo | null,
		n: number,
	): Promise<PrEnrichment> {
		if (!info) {
			return { info: null, checks: null, linkedTickets: [], fetchedAt: this.deps.now(), deletedOnForge: true };
		}
		const [checks, linkedTickets] = await Promise.all([repository.getChecks(n), repository.getLinkedTickets(n)]);
		return { info, checks, linkedTickets, fetchedAt: this.deps.now(), deletedOnForge: false };
	}

	private recordFailure(entry: RepoEntry, err: unknown): void {
		const forgeError = err instanceof ForgeError ? err : new ForgeError('network', String(err));
		entry.backoff = nextBackoff(entry.backoff, forgeError, this.deps.now());
		entry.lastError = `${forgeError.kind}: ${forgeError.message}`;
	}

	private degradedDetail(entry: RepoEntry): string {
		const until = entry.backoff.until;
		const retry = until !== null ? ` — retrying after ${new Date(until).toISOString()}` : '';
		return `${entry.lastError ?? 'throttled to protect rate budget'}${retry}`;
	}

	private oldestDataAgeMs(): number | null {
		const fetchTimes = [...this.repos.values()].flatMap((entry) => [...entry.prs.values()].map((pr) => pr.fetchedAt));
		if (fetchTimes.length === 0) return null;
		return this.deps.now() - Math.min(...fetchTimes);
	}
}

interface RefreshOptions {
	scope: 'all' | 'changed';
	changed?: number[];
	force?: boolean;
}
