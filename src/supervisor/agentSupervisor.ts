/**
 * Fleet supervision (design/09-launch-and-supervision.md): one SupervisedRunner
 * per approved (repo, agent), parking honored via wake triggers, daemon
 * wedge checks. vscode-free; the host supplies spawning, approval gating,
 * logging, and focus state.
 */

import { DispatchItem, DispatchPlan, LaunchAgent, OrchestratorFile, ParkedState, WORKER_ID } from '../protocol/types';
import { AgentProcessState, WorkerProcessState } from '../queue/queueInputs';
import { SupervisedRunner, Spawner, launchAgentToRequest } from './supervisedRunner';
import { resolveWorkerRequest } from './launchTemplate';
import { WorkerRunner } from './workerRunner';

const WEDGE_CHECK_MS = 60_000;
const IDLE_PAUSE_MS = 30 * 60_000;

export interface SupervisorDeps {
	spawn: Spawner;
	/**
	 * Spawner for `type:"built-in"` entries — the in-process planner pass, which
	 * presents as a one-shot process. Optional: absent in headless/test contexts
	 * with no built-in entries.
	 */
	builtInSpawn?: Spawner;
	now(): number;
	schedule(fn: () => void, ms: number): () => void;
	log(repoRoot: string, agentId: string, line: string): void;
	onStateChange(): void;
}

export interface SupervisorSettings {
	enabled: boolean;
	pauseWhenIdle: boolean;
	maxRestarts: number;
}

interface RepoSupervision {
	runners: Map<string, SupervisedRunner>;
	/** The worker launch template (the entry with reserved id 'worker'; first
	 *  wins); null if none declared. */
	workerTemplate: LaunchAgent | null;
	/** Live worker processes, keyed by dispatch item key (≤1 per key). */
	workers: Map<string, WorkerRunner>;
	parked: ParkedState | null;
	lastPassFinishedAt: number | null;
	/** passCount of the dispatch plan last reconciled — the host re-feeds the
	 *  orchestrator on every .status-pipe/ write, so a plan is acted on once.
	 *  `reconciledAny` distinguishes "never reconciled" from "reconciled a plan
	 *  whose passCount was null", so a passCount-less plan is acted on once, not
	 *  dropped (null === null would otherwise collide with the initial value). */
	reconciledDispatchPass: number | null;
	reconciledAny: boolean;
	cancelRecheck: (() => void) | null;
}

export class AgentSupervisor {
	private readonly repos = new Map<string, RepoSupervision>();
	private settings: SupervisorSettings;
	private lastFocusAt: number;
	private cancelWedgeTimer: (() => void) | null = null;

	constructor(
		private readonly deps: SupervisorDeps,
		settings: SupervisorSettings,
	) {
		this.settings = settings;
		this.lastFocusAt = deps.now();
		this.scheduleWedgeCheck();
	}

	updateSettings(settings: SupervisorSettings): void {
		this.settings = settings;
		if (!settings.enabled) this.stopAll();
	}

	noteFocus(): void {
		this.lastFocusAt = this.deps.now();
	}

	private isIdlePaused(): boolean {
		return this.settings.pauseWhenIdle && this.deps.now() - this.lastFocusAt > IDLE_PAUSE_MS;
	}

	private repo(repoRoot: string): RepoSupervision {
		let repo = this.repos.get(repoRoot);
		if (!repo) {
			repo = {
				runners: new Map(),
				workerTemplate: null,
				workers: new Map(),
				parked: null,
				lastPassFinishedAt: null,
				reconciledDispatchPass: null,
				reconciledAny: false,
				cancelRecheck: null,
			};
			this.repos.set(repoRoot, repo);
		}
		return repo;
	}

	/**
	 * Install the APPROVED agents for a repo (the host has already passed
	 * them through workspace trust + content-hash approval; worktree repos
	 * never reach here — discovery refuses to supervise them).
	 */
	setAgents(repoRoot: string, agents: LaunchAgent[]): void {
		const repo = this.repo(repoRoot);
		for (const runner of repo.runners.values()) runner.dispose();
		repo.runners.clear();
		// The worker template is not scheduled — it is instantiated on demand
		// per dispatch item (design/09). The reserved id 'worker' marks it.
		repo.workerTemplate = agents.find((a) => a.id === WORKER_ID) ?? null;
		if (!this.settings.enabled) {
			this.stopWorkers(repo);
			return;
		}
		for (const agent of agents) {
			if (agent.id === WORKER_ID) continue;
			repo.runners.set(agent.id, this.buildRunner(repoRoot, agent, repo));
		}
		this.deps.onStateChange();
	}

	/**
	 * Spawn the workers the planner stamped this pass (orchestrator.json
	 * dispatch). One live worker per key; total capped at the plan's
	 * maxConcurrent. Workers already running for a key are left to finish — the
	 * planner only re-lists a key once its worker has exited.
	 */
	private reconcileWorkers(repoRoot: string, repo: RepoSupervision, plan: DispatchPlan | null): void {
		if (!this.settings.enabled || !plan || plan.items.length === 0) return;
		if (!repo.workerTemplate) {
			// Log the gap to the shared 'worker' channel (where worker output lands)
			// so the operator finds it, not a tick channel that may not exist.
			// "no APPROVED": the supervisor only ever sees approved entries, so a
			// committed-but-unapproved worker entry also lands here — the fix is
			// approval, not adding an entry. (Absent entries are unapproved too.)
			this.deps.log(
				repoRoot,
				'worker',
				`[supervisor] ${plan.items.length} workers planned but no approved launch entry with id '${WORKER_ID}' — none spawned`,
			);
			return;
		}
		const cap = Math.max(0, plan.maxConcurrent);
		for (const item of plan.items) {
			if (repo.workers.size >= cap) break;
			if (repo.workers.has(item.key)) continue;
			this.spawnWorker(repoRoot, repo, item);
		}
	}

	private spawnWorker(repoRoot: string, repo: RepoSupervision, item: DispatchItem): void {
		const template = repo.workerTemplate;
		if (!template) return;
		const request = resolveWorkerRequest(launchAgentToRequest(template), item.prompt, item.worktree);
		// All workers share one OutputChannel per repo. A per-key channel would
		// never be disposed (channels live until controller teardown), leaking
		// one channel per ticket ever dispatched and cluttering the Output
		// dropdown; the per-worker start/end banners delimit the interleaved
		// streams, and the operator monitors workers from the agents strip.
		const channel = 'worker';
		const runner = new WorkerRunner(item.key, request, template.timeoutMinutes, {
			spawn: this.deps.spawn,
			now: () => this.deps.now(),
			schedule: (fn, ms) => this.deps.schedule(fn, ms),
			log: (line) => this.deps.log(repoRoot, channel, line),
			onDone: () => {
				repo.workers.delete(item.key);
				this.deps.onStateChange();
			},
		});
		repo.workers.set(item.key, runner);
		runner.start();
		this.deps.onStateChange();
	}

	private stopWorkers(repo: RepoSupervision): void {
		for (const worker of repo.workers.values()) worker.dispose();
		repo.workers.clear();
	}

	private buildRunner(repoRoot: string, agent: LaunchAgent, repo: RepoSupervision): SupervisedRunner {
		// A built-in entry runs the in-process planner pass through its own
		// spawner; everything else spawns a real process. With no built-in
		// spawner wired (headless/test), fail loudly rather than spawning the
		// entry's empty command into a cryptic ENOENT.
		const spawn = agent.type === 'built-in' ? (this.deps.builtInSpawn ?? missingBuiltInSpawn) : this.deps.spawn;
		return new SupervisedRunner(repoRoot, agent, {
			spawn,
			now: () => this.deps.now(),
			schedule: (fn, ms) => this.deps.schedule(fn, ms),
			log: (line) => this.deps.log(repoRoot, agent.id, line),
			onStateChange: () => this.deps.onStateChange(),
			isParked: () => repo.parked,
			isIdlePaused: () => this.isIdlePaused(),
			maxRestarts: () => this.settings.maxRestarts,
		});
	}

	/** Orchestrator file changed: parking, pass progress, and dispatch feed in here. */
	noteOrchestrator(repoRoot: string, file: OrchestratorFile | null): void {
		const repo = this.repo(repoRoot);
		repo.parked = file?.parked ?? null;
		this.noteLastPassFinished(repo, file?.lastPassFinishedAt ?? null);
		// A parked daemon is stopped, not left running (design/09) — ticks
		// park themselves at the next timer, daemons need the supervisor.
		if (repo.parked) for (const runner of repo.runners.values()) runner.parkDaemon();
		this.maybeReconcileDispatch(repoRoot, repo, file);
		this.armParkedRecheck(repo);
		this.deps.onStateChange();
	}

	private noteLastPassFinished(repo: RepoSupervision, iso: string | null): void {
		const finished = iso ? Date.parse(iso) : NaN;
		if (!Number.isNaN(finished)) repo.lastPassFinishedAt = finished;
	}

	/**
	 * Reconcile a dispatch plan at most once per planner pass. The host re-feeds
	 * orchestrator.json on EVERY .status-pipe/ write (worker heartbeats, acks,
	 * ticket writes) and the plan persists on disk until the next pass overwrites
	 * it, so without this guard a stale re-read would re-spawn a key whose worker
	 * already exited (design/09: the NEXT pass decides re-dispatch, not a re-read).
	 */
	private maybeReconcileDispatch(repoRoot: string, repo: RepoSupervision, file: OrchestratorFile | null): void {
		if (!file?.dispatch) return;
		// While disabled, leave the guard UNTOUCHED so the plan stays eligible:
		// reconcileWorkers no-ops when disabled, so advancing the guard here would
		// mark the pass done-without-spawning and the host's re-feed on enable would
		// then skip it — planned work stranded until the next pass or staleness.
		if (!this.settings.enabled) return;
		// Same strand for an unapproved worker template: reconcileWorkers logs the
		// gap (so the operator knows to approve) but spawns nothing, so DON'T advance
		// the guard — once the worker entry is approved and the host re-feeds, this
		// pass must still reconcile, not be marked done.
		if (!repo.workerTemplate) {
			this.reconcileWorkers(repoRoot, repo, file.dispatch);
			return;
		}
		const pass = file.passCount ?? null;
		if (repo.reconciledAny && pass === repo.reconciledDispatchPass) return;
		repo.reconciledAny = true;
		repo.reconciledDispatchPass = pass;
		this.reconcileWorkers(repoRoot, repo, file.dispatch);
	}

	/** recheckAfter elapsing is a wake trigger — parking can never strand the loop. */
	private armParkedRecheck(repo: RepoSupervision): void {
		repo.cancelRecheck?.();
		repo.cancelRecheck = null;
		const recheckAfter = repo.parked?.recheckAfter ? Date.parse(repo.parked.recheckAfter) : NaN;
		if (Number.isNaN(recheckAfter)) return;
		const delay = Math.max(0, recheckAfter - this.deps.now());
		repo.cancelRecheck = this.deps.schedule(() => this.wakeRepo(repo, 'recheckAfter elapsed'), delay);
	}

	/** An ack file appeared — the "Ready for another look" click IS the resume button. */
	noteAckCreated(repoRoot: string): void {
		this.wakeRepo(this.repo(repoRoot), 'ack created');
	}

	/** Epic / inbox change on disk (operator edited the backlog). */
	noteBacklogChanged(repoRoot: string): void {
		this.wakeRepo(this.repo(repoRoot), 'backlog changed');
	}

	private wakeRepo(repo: RepoSupervision, why: string): void {
		// Wake clears the local pause; the running pass consumes the ack (or
		// re-declares parked, which re-suspends).
		repo.parked = null;
		for (const runner of repo.runners.values()) {
			this.deps.log(runner.repoRoot, runner.agent.id, `[supervisor] wake: ${why}`);
			runner.wake();
		}
	}

	private scheduleWedgeCheck(): void {
		this.cancelWedgeTimer = this.deps.schedule(() => {
			for (const repo of this.repos.values()) {
				for (const runner of repo.runners.values()) runner.checkDaemonWedged(repo.lastPassFinishedAt);
			}
			this.scheduleWedgeCheck();
		}, WEDGE_CHECK_MS);
	}

	control(repoRoot: string, agentId: string, action: 'start' | 'stop' | 'tickNow' | 'retry'): void {
		const runner = this.repos.get(repoRoot)?.runners.get(agentId);
		if (!runner) return;
		if (action === 'stop') runner.stop();
		else if (action === 'retry') runner.retry();
		else if (action === 'tickNow') runner.tickNow();
		else runner.start();
	}

	startAll(): void {
		this.forEachRunner((r) => r.start());
	}

	stopAll(): void {
		this.forEachRunner((r) => r.stop());
		for (const repo of this.repos.values()) this.stopWorkers(repo);
	}

	tickNow(repoRoot?: string): void {
		this.forEachRunner((r) => {
			if (!repoRoot || r.repoRoot === repoRoot) r.tickNow();
		});
	}

	private forEachRunner(fn: (runner: SupervisedRunner) => void): void {
		for (const repo of this.repos.values()) {
			for (const runner of repo.runners.values()) fn(runner);
		}
	}

	states(): AgentProcessState[] {
		const out: AgentProcessState[] = [];
		this.forEachRunner((r) => out.push(r.snapshot()));
		return out;
	}

	/** Keys of live worker processes in a repo — the planner's never-re-dispatch set. */
	liveWorkerKeys(repoRoot: string): string[] {
		return [...(this.repos.get(repoRoot)?.workers.keys() ?? [])];
	}

	/** Live worker processes across all repos, for the agents strip. */
	workerStates(): WorkerProcessState[] {
		const out: WorkerProcessState[] = [];
		for (const [repoRoot, repo] of this.repos) {
			for (const worker of repo.workers.values()) out.push({ repoRoot, ...worker.snapshot() });
		}
		return out;
	}

	dispose(): void {
		this.cancelWedgeTimer?.();
		for (const repo of this.repos.values()) {
			repo.cancelRecheck?.();
			for (const runner of repo.runners.values()) runner.dispose();
			this.stopWorkers(repo);
		}
		this.repos.clear();
	}
}

/**
 * Stand-in spawner for a `built-in` entry when no in-process planner spawner is
 * wired (headless/test contexts). A built-in entry carries no real command, so
 * the default process spawner would fail with a cryptic ENOENT; this reports a
 * clear line and exits non-zero so the runner records a normal failure instead.
 */
const missingBuiltInSpawn: Spawner = (_request, events) => {
	events.onOutput('[supervisor] built-in entry has no in-process planner spawner in this context\n');
	events.onExit(1);
	return { kill: () => undefined };
};
