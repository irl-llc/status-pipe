/**
 * Unit tests for host/workerLogStore.ts — the fs-backed worker-log sink: it
 * rotates prior attempts (keeping the last WORKER_LOG_KEEP) and writes the
 * current run, degrading to a silent no-op when the dir can't be created.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { WORKER_LOG_KEEP, workerLogPath } from '../../../supervisor/workerLog';
import { openWorkerLogFile } from '../../../host/workerLogStore';

/** Open one run's sink, write a line, close it, and wait for the flush to land. */
async function attempt(protocolDir: string, key: string, text: string): Promise<void> {
	const sink = openWorkerLogFile(protocolDir, key);
	sink.write(text);
	sink.close();
	const file = workerLogPath(protocolDir, key);
	for (let i = 0; i < 100; i++) {
		if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
		await delay(10);
	}
	throw new Error(`worker log never flushed: ${file}`);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('host/workerLogStore', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-worker-log-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('writes the current run under <protocolDir>/logs', async () => {
		await attempt(dir, '853', 'hello\n');
		assert.equal(fs.readFileSync(workerLogPath(dir, '853'), 'utf8'), 'hello\n');
	});

	it('rotates prior attempts and keeps the last WORKER_LOG_KEEP', async () => {
		const base = workerLogPath(dir, '853');
		await attempt(dir, '853', 'one\n');
		await attempt(dir, '853', 'two\n');
		await attempt(dir, '853', 'three\n');
		await attempt(dir, '853', 'four\n');

		assert.equal(WORKER_LOG_KEEP, 3);
		assert.equal(fs.readFileSync(base, 'utf8'), 'four\n');
		assert.equal(fs.readFileSync(`${base}.1`, 'utf8'), 'three\n');
		assert.equal(fs.readFileSync(`${base}.2`, 'utf8'), 'two\n');
		// 'one' is the dropped oldest — no fourth attempt survives.
		assert.equal(fs.existsSync(`${base}.3`), false);
	});

	it('isolates logs per key', async () => {
		await attempt(dir, '853', 'a-log\n');
		await attempt(dir, 'PROJ-9', 'b-log\n');
		assert.equal(fs.readFileSync(workerLogPath(dir, '853'), 'utf8'), 'a-log\n');
		assert.equal(fs.readFileSync(workerLogPath(dir, 'PROJ-9'), 'utf8'), 'b-log\n');
	});

	it('degrades to a no-op sink when the logs dir cannot be created', () => {
		// A file where the logs dir should be makes mkdir fail; the sink must not throw.
		fs.writeFileSync(path.join(dir, 'logs'), 'not a dir');
		const sink = openWorkerLogFile(dir, '853');
		assert.doesNotThrow(() => {
			sink.write('x');
			sink.close();
		});
	});
});
