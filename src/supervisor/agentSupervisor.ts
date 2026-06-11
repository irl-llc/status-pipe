/**
 * Fleet supervision (design/09-launch-and-supervision.md): one AgentRunner
 * per approved (repo, agent), parking honored via wake triggers, daemon
 * wedge checks. vscode-free; the host supplies spawning, approval gating,
 * logging, and focus state.
 */

import { LaunchAgent, OrchestratorFile, ParkedState } from '../protocol/types';
import { AgentProcessState } from '../queue/queueInputs';
import { AgentRunner, Spawner } from './agentRunner';

const WEDGE_CHECK_MS = 60_000;
const IDLE_PAUSE_MS = 30 * 60_000;

export interface SupervisorDeps {
	spawn: Spawner;
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
	runners: Map<string, AgentRunner>;
	parked: ParkedState | null;
	lastPassFinishedAt: number | null;
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
			repo = { runners: new Map(), parked: null, lastPassFinishedAt: null, cancelRecheck: null };
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
		if (!this.settings.enabled) return;
		for (const agent of agents) {
			repo.runners.set(agent.id, this.buildRunner(repoRoot, agent, repo));
		}
		this.deps.onStateChange();
	}

	private buildRunner(repoRoot: string, agent: LaunchAgent, repo: RepoSupervision): AgentRunner {
		return new AgentRunner(repoRoot, agent, {
			spawn: this.deps.spawn,
			now: () => this.deps.now(),
			schedule: (fn, ms) => this.deps.schedule(fn, ms),
			log: (line) => this.deps.log(repoRoot, agent.id, line),
			onStateChange: () => this.deps.onStateChange(),
			isParked: () => repo.parked,
			isIdlePaused: () => this.isIdlePaused(),
			maxRestarts: () => this.settings.maxRestarts,
		});
	}

	/** Orchestrator file changed: parking + pass progress feed in here. */
	noteOrchestrator(repoRoot: string, file: OrchestratorFile | null): void {
		const repo = this.repo(repoRoot);
		repo.parked = file?.parked ?? null;
		const finished = file?.lastPassFinishedAt ? Date.parse(file.lastPassFinishedAt) : NaN;
		repo.lastPassFinishedAt = Number.isNaN(finished) ? repo.lastPassFinishedAt : finished;
		this.armParkedRecheck(repo);
		this.deps.onStateChange();
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
		else runner.start();
	}

	startAll(): void {
		this.forEachRunner((r) => r.start());
	}

	stopAll(): void {
		this.forEachRunner((r) => r.stop());
	}

	tickNow(repoRoot?: string): void {
		this.forEachRunner((r) => {
			if (!repoRoot || r.repoRoot === repoRoot) r.start();
		});
	}

	private forEachRunner(fn: (runner: AgentRunner) => void): void {
		for (const repo of this.repos.values()) {
			for (const runner of repo.runners.values()) fn(runner);
		}
	}

	states(): AgentProcessState[] {
		const out: AgentProcessState[] = [];
		this.forEachRunner((r) => out.push(r.snapshot()));
		return out;
	}

	dispose(): void {
		this.cancelWedgeTimer?.();
		for (const repo of this.repos.values()) {
			repo.cancelRecheck?.();
			for (const runner of repo.runners.values()) runner.dispose();
		}
		this.repos.clear();
	}
}
