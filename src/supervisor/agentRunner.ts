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
			mode: this.agent.mode,
			state: this.displayState(),
			nextTickAt: this.nextTickAt,
			runningSince: this.runningSince,
			lastOutputAt: this.lastOutputAt,
			consecutiveFailures: this.consecutiveFailures,
			lastExitCode: this.lastExitCode,
			detail: this.detail,
		};
	}

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

	stop(): void {
		this.clearTimers();
		if (this.handle) {
			this.detail = 'stopped by operator';
			this.handle.kill();
			this.handle = null;
		}
		this.setState('stopped');
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
		if (this.agent.mode !== 'daemon' || this.state !== 'running') return;
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

	private launch(): void {
		this.setState('launching');
		this.detail = null;
		this.timedOut = false;
		try {
			this.handle = this.deps.spawn(this.spawnRequest(), {
				onOutput: (chunk) => this.onOutput(chunk),
				onExit: (code) => this.onExit(code),
			});
		} catch (err) {
			this.onExit(spawnFailureCode(err, this.deps.log));
			return;
		}
		this.runningSince = this.deps.now();
		this.lastOutputAt = null;
		this.setState('running');
		this.armTimeout();
	}

	private spawnRequest(): SpawnRequest {
		return {
			command: this.agent.command,
			args: this.agent.args,
			cwd: this.agent.cwd,
			env: this.agent.env,
			stdin: this.agent.stdin,
		};
	}

	private armTimeout(): void {
		if (this.agent.mode !== 'tick') return;
		this.cancelTimeout = this.deps.schedule(() => {
			this.timedOut = true;
			this.detail = `tick exceeded ${this.agent.timeoutMinutes}m — killed`;
			this.deps.log(`[supervisor] ${this.detail}`);
			this.handle?.kill();
		}, this.agent.timeoutMinutes * 60_000);
	}

	private onOutput(chunk: string): void {
		this.lastOutputAt = this.deps.now();
		this.deps.log(chunk);
		this.deps.onStateChange();
	}

	private onExit(code: number | null): void {
		this.cancelTimeout?.();
		this.cancelTimeout = null;
		this.handle = null;
		this.lastExitCode = code;
		const uptimeMs = this.runningSince !== null ? this.deps.now() - this.runningSince : 0;
		this.runningSince = null;
		if (this.state === 'stopped') return; // operator stop — no reschedule
		this.routeExit(code, uptimeMs);
	}

	private routeExit(code: number | null, uptimeMs: number): void {
		const cleanTick = this.agent.mode === 'tick' && code === 0 && !this.timedOut;
		// A daemon that ran a while before dying restarts cleanly; one that
		// dies within a minute is failing and takes the backoff path.
		const healthyDaemon = this.agent.mode === 'daemon' && uptimeMs >= DAEMON_HEALTHY_UPTIME_MS && !this.timedOut;
		if (cleanTick || healthyDaemon) {
			this.consecutiveFailures = 0;
			this.detail = null;
			if (this.pendingWake) {
				this.pendingWake = false;
				this.launch();
				return;
			}
			// Interval measured from exit — no overlap, ever.
			this.scheduleNext(this.agent.mode === 'tick' ? this.agent.intervalMinutes * 60_000 : 1_000);
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
