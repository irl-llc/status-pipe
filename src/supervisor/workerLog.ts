/**
 * Worker process telemetry on disk (design/09-launch-and-supervision.md,
 * design/10-naming.md): each worker run's stdout/stderr is persisted to
 * `.status-pipe/logs/worker-<key>.log` so a FAILED worker's output survives an
 * extension reload and stays isolated per worker — the shared OutputChannel is
 * live-only and interleaves every worker in the repo. This is supervisor-owned
 * *process* telemetry, never an agent-owned protocol file. vscode-free: the fs
 * sink is injected by the host (the rotation/write impl lives in host/).
 */

import * as path from 'path';

/** Subdir under the protocol dir that holds worker logs (auto-ignored: the
 *  recommended `.status-pipe/*` rule covers it). */
export const WORKER_LOG_DIR = 'logs';

/** Worker attempts retained per key: the current run plus rotated `.1 .. .N-1`. */
export const WORKER_LOG_KEEP = 3;

/** A line sink for one worker run; the host backs it with an fs write stream. */
export interface WorkerLogSink {
	write(line: string): void;
	close(): void;
}

/** Opens (and rotates) the on-disk log for one worker run. Injected through
 *  SupervisorDeps; absent in headless/test contexts (then no disk log). */
export type WorkerLogOpener = (repoRoot: string, key: string) => WorkerLogSink;

/** Ticket keys are filesystem-safe by protocol, but a log filename is new
 *  surface — sanitize defensively so a stray char can't escape the logs dir. */
export function workerLogFileName(key: string): string {
	return `worker-${key.replace(/[^A-Za-z0-9._-]/g, '_')}.log`;
}

/** Absolute path of a worker's current log file; shared by writer and reader so
 *  the host opens exactly what the supervisor wrote. */
export function workerLogPath(protocolDir: string, key: string): string {
	return path.join(protocolDir, WORKER_LOG_DIR, workerLogFileName(key));
}
