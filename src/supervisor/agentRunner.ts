/**
 * One (repo, agent) state machine (design/09-launch-and-supervision.md):
 *
 *   stopped → scheduled(nextTickAt) → launching → running
 *                    ↑                    ├─ exit 0 (tick) → scheduled
 *                    │                    ├─ exit ≠0 / timeout → backoff(n)
 *                    └────── backoff ─────┴─ exhausted → failed
 *
 * vscode-free: process spawning, clock, and timers are injected.
 */

import { ClaudeActivityReducer } from '../output/claudeStream';
import { LaunchAgent, ParkedState } from '../protocol/types';
import { AgentRunState } from '../queue/displayTypes';
import { AgentProcessState } from '../queue/queueInputs';

export interface SpawnRequest {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	stdin: string;
}

/** Map a launch entry's process fields onto a SpawnRequest (the spawner's input). */
export function launchAgentToRequest(agent: LaunchAgent): SpawnRequest {
	return { command: agent.command, args: agent.args, cwd: agent.cwd, env: agent.env, stdin: agent.stdin };
}

export interface ProcessEvents {
	onOutput(chunk: string): void;
	onExit(code: number | null): void;
}

export interface ProcessHandle {
	kill(): void;
}

export type Spawner = (request: SpawnRequest, events: ProcessEvents) => ProcessHandle;

export interface RunnerDeps {
	spawn: Spawner;
	now(): number;
	schedule(fn: () => void, ms: number): () => void;
	log(line: string): void;
	onStateChange(): void;
	/** Live parked state for this repo (orchestrator-declared). */
	isParked(): ParkedState | null;
	/** Scheduling pause from pauseWhenIdle (host-computed). */
	isIdlePaused(): boolean;
	maxRestarts(): number;
}

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 15 * 60_000;
const DAEMON_HEALTHY_UPTIME_MS = 60_000;
const PARKED_RECHECK_MS = 60_000;

export class AgentRunner {
	private state: AgentRunState = 'stopped';
	private nextTickAt: number | null = null;
	private runningSince: number | null = null;
	private lastOutputAt: number | null = null;
	private consecutiveFailures = 0;
	private lastExitCode: number | null = null;
	private detail: string | null = null;
	private handle: ProcessHandle | null = null;
	private cancelTimer: (() => void) | null = null;
	private cancelTimeout: (() => void) | null = null;
	private timedOut = false;

	constructor(
		readonly repoRoot: string,
		readonly agent: LaunchAgent,
		private readonly deps: RunnerDeps,
	) {}

	snapshot(): AgentProcessState {
		return {
			repoRoot: this.repoRoot,
			agentId: this.agent.id,
			title: this.agent.title,
			lifetime: this.agent.lifetime,
			state: this.displayState(),
			nextTickAt: this.nextTickAt,
			runningSince: this.runningSince,
			lastOutputAt: this.lastOutputAt,
			consecutiveFailures: this.consecutiveFailures,
			lastExitCode: this.lastExitCode,
			detail: this.detail,
			activity: this.reducer.snapshot(),
		};
	}

	/** Folds the launcher's stream-json stdout into a live AgentActivity. */
	private readonly reducer = new ClaudeActivityReducer();

	private displayState(): AgentRunState {
		if (this.state === 'scheduled' && this.deps.isParked()) return 'parked';
		return this.state;
	}

	/** Manual start / tick-now: immediate launch regardless of parking. */
	start(): void {
		if (this.state === 'running' || this.state === 'launching') return;
		this.clearTimers();
		this.launch();
	}

	/**
	 * Manual tick-now: an immediate pass no matter the state — a running
	 * agent gets a follow-up pass on exit instead of being skipped.
	 */
	tickNow(): void {
		if (this.state === 'running' || this.state === 'launching') this.wake();
		else this.start();
	}

	stop(): void {
		this.clearTimers();
		// A wake aimed at the loop the operator just stopped must not fire a
		// phantom launch after a later manual start.
		this.pendingWake = false;
		if (this.handle) {
			this.detail = 'stopped by operator';
			this.handle.kill();
			this.handle = null;
		}
		this.runningSince = null;
		this.setState('stopped');
	}

	/**
	 * Orchestrator declared `parked`: a daemon is stopped and relaunched on
	 * the same wake triggers (design/09). The recheck timer lands in
	 * onTimerFired, whose parking gate keeps it suspended until a wake.
	 */
	parkDaemon(): void {
		if (this.agent.lifetime !== 'daemon') return;
		if (this.state !== 'running' && this.state !== 'launching') return;
		this.clearTimers();
		this.pendingWake = false;
		this.detail = this.deps.isParked()?.reason ?? 'parked';
		this.handle?.kill();
		this.handle = null;
		this.runningSince = null;
		this.scheduleNext(PARKED_RECHECK_MS);
	}

	private pendingWake = false;

	/**
	 * Ack created / backlog changed: wake a parked or scheduled loop now.
	 * If a pass is already running it will consume the ack — but in case it
	 * was past its inbox scan, a follow-up tick fires on exit.
	 */
	wake(): void {
		if (this.state === 'scheduled' || this.state === 'backoff') {
			this.clearTimers();
			this.launch();
		} else if (this.state === 'running' || this.state === 'launching') {
			this.pendingWake = true;
		}
	}

	/** Daemon wedge check: no orchestrator progress for 2× interval ⇒ restart. */
	checkDaemonWedged(lastPassFinishedAt: number | null): void {
		if (this.agent.lifetime !== 'daemon' || this.state !== 'running') return;
		const started = this.runningSince ?? this.deps.now();
		const reference = Math.max(lastPassFinishedAt ?? 0, started);
		if (this.deps.now() - reference > 2 * this.agent.intervalMinutes * 60_000) {
			this.detail = 'wedged — no orchestrator progress; restarting';
			this.deps.log(`[supervisor] ${this.detail}`);
			this.failCurrentRun();
		}
	}

	private scheduleNext(delayMs: number): void {
		this.clearTimers();
		this.nextTickAt = this.deps.now() + delayMs;
		this.setState(this.consecutiveFailures > 0 ? 'backoff' : 'scheduled');
		this.cancelTimer = this.deps.schedule(() => this.onTimerFired(), delayMs);
	}

	private onTimerFired(): void {
		this.cancelTimer = null;
		if (this.deps.isParked() || this.deps.isIdlePaused()) {
			// Parked: skip the pass, re-check periodically (recheckAfter and
			// ack wakes arrive via wake()); idle-pause behaves the same.
			this.detail = this.deps.isParked()?.reason ?? 'paused (window idle)';
			this.scheduleNext(PARKED_RECHECK_MS);
			return;
		}
		this.launch();
	}

	private spawnSeq = 0;

	private launch(): void {
		this.setState('launching');
		this.detail = null;
		this.timedOut = false;
		// New run: clear last run's parsed activity and mark the raw log so
		// the OutputChannel stays browsable across restarts.
		this.reducer.reset();
		this.deps.log(`\n══════ run started ${new Date(this.deps.now()).toISOString()} ══════\n`);
		const seq = ++this.spawnSeq;
		try {
			const handle = this.deps.spawn(this.spawnRequest(), {
				onOutput: (chunk) => this.onOutput(chunk),
				onExit: (code) => this.onExit(code, seq),
			});
			// A spawner may report exit synchronously; the machine has
			// already routed it — don't resurrect the run.
			if (this.state !== 'launching' || seq !== this.spawnSeq) return;
			this.handle = handle;
		} catch (err) {
			this.onExit(spawnFailureCode(err, this.deps.log), seq);
			return;
		}
		this.markRunning();
	}

	private markRunning(): void {
		this.runningSince = this.deps.now();
		this.lastOutputAt = null;
		this.setState('running');
		this.armTimeout();
	}

	private spawnRequest(): SpawnRequest {
		return launchAgentToRequest(this.agent);
	}

	private armTimeout(): void {
		if (this.agent.lifetime !== 'scheduled') return;
		this.cancelTimeout = this.deps.schedule(() => {
			this.timedOut = true;
			this.detail = `pass exceeded ${this.agent.timeoutMinutes}m — killed`;
			this.deps.log(`[supervisor] ${this.detail}`);
			this.handle?.kill();
		}, this.agent.timeoutMinutes * 60_000);
	}

	private onOutput(chunk: string): void {
		this.lastOutputAt = this.deps.now();
		this.reducer.pushChunk(chunk);
		this.deps.log(chunk);
		this.deps.onStateChange();
	}

	private onExit(code: number | null, seq: number): void {
		// Inert exits: a stale event from a previous spawn, a spawner that
		// double-fires, or the late SIGTERM landing after stop()/parkDaemon()
		// already settled the machine. stop/park clear runningSince/handle
		// themselves, so there is no bookkeeping left to do here.
		if (seq !== this.spawnSeq) return;
		if (this.state !== 'running' && this.state !== 'launching') return;
		this.cancelTimeout?.();
		this.cancelTimeout = null;
		this.handle = null;
		this.lastExitCode = code;
		const uptimeMs = this.runningSince !== null ? this.deps.now() - this.runningSince : 0;
		this.runningSince = null;
		this.deps.log(`══════ run ended (exit ${code ?? 'signal'}, ${Math.round(uptimeMs / 1000)}s) ══════\n`);
		this.routeExit(code, uptimeMs);
	}

	private routeExit(code: number | null, uptimeMs: number): void {
		const cleanTick = this.agent.lifetime === 'scheduled' && code === 0 && !this.timedOut;
		// A daemon that ran a while before dying restarts cleanly; one that
		// dies within a minute is failing and takes the backoff path.
		const healthyDaemon = this.agent.lifetime === 'daemon' && uptimeMs >= DAEMON_HEALTHY_UPTIME_MS && !this.timedOut;
		if (cleanTick || healthyDaemon) {
			this.consecutiveFailures = 0;
			this.detail = null;
			if (this.pendingWake) {
				this.pendingWake = false;
				this.launch();
				return;
			}
			// Interval measured from exit — no overlap, ever.
			this.scheduleNext(this.agent.lifetime === 'scheduled' ? this.agent.intervalMinutes * 60_000 : 1_000);
			return;
		}
		this.recordFailure(code);
	}

	private recordFailure(code: number | null): void {
		this.consecutiveFailures += 1;
		this.detail = this.timedOut ? this.detail : `exit ${code ?? 'signal'} ×${this.consecutiveFailures}`;
		if (this.consecutiveFailures >= this.deps.maxRestarts()) {
			this.setState('failed');
			this.nextTickAt = null;
			return;
		}
		const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1));
		this.scheduleNext(backoff);
	}

	/** Kill the running process and route it through the failure path. */
	private failCurrentRun(): void {
		this.timedOut = true;
		this.handle?.kill();
	}

	/** Retry from `failed`: operator clicked retry on the synthetic card. */
	retry(): void {
		if (this.state !== 'failed') return;
		this.consecutiveFailures = 0;
		this.launch();
	}

	private clearTimers(): void {
		this.cancelTimer?.();
		this.cancelTimer = null;
		this.cancelTimeout?.();
		this.cancelTimeout = null;
		this.nextTickAt = null;
	}

	private setState(state: AgentRunState): void {
		this.state = state;
		this.deps.onStateChange();
	}

	dispose(): void {
		this.stop();
	}
}

function spawnFailureCode(err: unknown, log: (line: string) => void): number {
	log(`[supervisor] spawn failed: ${err instanceof Error ? err.message : String(err)}`);
	return 127;
}
