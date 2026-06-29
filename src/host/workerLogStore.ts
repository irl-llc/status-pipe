/**
 * The fs-backed worker-log sink (design/09): on worker start, mkdir the logs
 * dir, rotate the prior attempts, and open a fresh write stream. Kept out of
 * the vscode-free supervisor — only the host touches the filesystem. Disk
 * logging is best-effort: any setup failure degrades to a no-op sink so it can
 * never crash a worker spawn.
 */

import * as fs from 'fs';
import * as path from 'path';

import { WORKER_LOG_DIR, WORKER_LOG_KEEP, WorkerLogSink, workerLogFileName } from '../supervisor/workerLog';

const NOOP_SINK: WorkerLogSink = { write: () => undefined, close: () => undefined };

export function openWorkerLogFile(protocolDir: string, key: string): WorkerLogSink {
	try {
		const dir = path.join(protocolDir, WORKER_LOG_DIR);
		fs.mkdirSync(dir, { recursive: true });
		const base = path.join(dir, workerLogFileName(key));
		rotate(base, WORKER_LOG_KEEP);
		const stream = fs.createWriteStream(base, { flags: 'w' });
		// A mid-run fs error (disk full, removed dir) must not crash the host.
		stream.on('error', () => undefined);
		return { write: (line) => void stream.write(line), close: () => stream.end() };
	} catch {
		return NOOP_SINK;
	}
}

/** Shift `base` -> `base.1` -> … dropping the oldest beyond `keep` attempts. */
function rotate(base: string, keep: number): void {
	fs.rmSync(`${base}.${keep - 1}`, { force: true });
	for (let i = keep - 2; i >= 1; i--) renameIfExists(`${base}.${i}`, `${base}.${i + 1}`);
	renameIfExists(base, `${base}.1`);
}

function renameIfExists(from: string, to: string): void {
	try {
		fs.renameSync(from, to);
	} catch {
		// Nothing to rotate at this slot.
	}
}
