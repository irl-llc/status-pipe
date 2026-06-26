/**
 * One worker process: a single `claude -p /status-pipe:work-ticket <key>` (or
 * work-epic) child the supervisor spawns from an orchestrator.json.dispatch
 * item (design/09-launch-and-supervision.md). Unlike SupervisedRunner this is
 * one-shot — no interval, no backoff, no parking: it runs one pass and exits,
 * and the NEXT planner pass decides whether to re-dispatch. A worker failure is
 * recorded in its ticket file by the worker (or staleness reconcile), never an
 * orchestrator failure. vscode-free: spawning, clock, and timers are injected.
 */

import { ClaudeActivityReducer } from '../output/claudeStream';
import { WorkerProcessState } from '../queue/queueInputs';
import { ProcessHandle, SpawnRequest, Spawner } from './supervisedRunner';

export interface WorkerRunnerDeps {
	spawn: Spawner;
	now(): number;
	schedule(fn: () => void, ms: number): () => void;
	log(line: string): void;
	/** Called once when the process exits or is killed — the pool removes it. */
	onDone(): void;
}

export class WorkerRunner {
	private runningSince: number | null = null;
	private lastOutputAt: number | null = null;
	private handle: ProcessHandle | null = null;
	private cancelTimeout: (() => void) | null = null;
	private exited = false;
	/** Folds the worker's stream-json stdout into a live activity summary. */
	private readonly reducer = new ClaudeActivityReducer();

	constructor(
		readonly key: string,
		private readonly request: SpawnRequest,
		private readonly timeoutMinutes: number,
		private readonly deps: WorkerRunnerDeps,
	) {}

	/** Live state for the agents strip (repoRoot is attached by the supervisor). */
	snapshot(): Omit<WorkerProcessState, 'repoRoot'> {
		return {
			key: this.key,
			runningSince: this.runningSince,
			lastOutputAt: this.lastOutputAt,
			activity: this.reducer.snapshot(),
		};
	}

	/** Spawn the process and arm its wall-clock timeout. Call exactly once. */
	start(): void {
		this.runningSince = this.deps.now();
		this.deps.log(`\n══════ worker ${this.key} started ${new Date(this.runningSince).toISOString()} ══════\n`);
		try {
			this.handle = this.deps.spawn(this.request, {
				onOutput: (chunk) => this.onOutput(chunk),
				onExit: (code) => this.onExit(code),
			});
		} catch (err) {
			this.deps.log(`[supervisor] worker ${this.key} spawn failed: ${errMessage(err)}\n`);
			this.onExit(127);
			return;
		}
		this.armTimeout();
	}

	get alive(): boolean {
		return !this.exited;
	}

	stop(): void {
		// Cancel the wall-clock timer so a stop/dispose can't leave it armed to
		// fire a late second kill after the process is already gone.
		this.cancelTimeout?.();
		this.cancelTimeout = null;
		this.handle?.kill();
	}

	dispose(): void {
		this.stop();
	}

	private armTimeout(): void {
		this.cancelTimeout = this.deps.schedule(() => {
			this.deps.log(`[supervisor] worker ${this.key} exceeded ${this.timeoutMinutes}m — killed\n`);
			this.handle?.kill();
		}, this.timeoutMinutes * 60_000);
	}

	private onOutput(chunk: string): void {
		this.lastOutputAt = this.deps.now();
		this.reducer.pushChunk(chunk);
		this.deps.log(chunk);
	}

	private onExit(code: number | null): void {
		if (this.exited) return;
		this.exited = true;
		this.cancelTimeout?.();
		this.cancelTimeout = null;
		this.handle = null;
		const uptimeMs = this.runningSince !== null ? this.deps.now() - this.runningSince : 0;
		this.deps.log(
			`══════ worker ${this.key} ended (exit ${code ?? 'signal'}, ${Math.round(uptimeMs / 1000)}s) ══════\n`,
		);
		this.deps.onDone();
	}
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
