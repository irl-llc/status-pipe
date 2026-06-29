/**
 * Unit tests for supervisor/workerLog.ts — the vscode-free path/name helpers
 * shared by the host's writer and reader (they must agree byte-for-byte).
 */

import assert from 'node:assert/strict';

import { WORKER_LOG_DIR, workerLogFileName, workerLogPath } from '../../../supervisor/workerLog';

describe('supervisor/workerLog', () => {
	it('names the file after the key', () => {
		assert.equal(workerLogFileName('853'), 'worker-853.log');
		assert.equal(workerLogFileName('PROJ-123'), 'worker-PROJ-123.log');
	});

	it('strips path separators so a key stays one filename segment', () => {
		// Dots are legal in keys and harmless inside a single segment; only the
		// separators that could traverse out of the logs dir are replaced.
		assert.equal(workerLogFileName('../../etc/passwd'), 'worker-.._.._etc_passwd.log');
		assert.equal(workerLogFileName('a/b'), 'worker-a_b.log');
		assert.equal(workerLogFileName('a\\b'), 'worker-a_b.log');
	});

	it('places the log under <protocolDir>/logs', () => {
		assert.equal(workerLogPath('/repo/.status-pipe', '853'), `/repo/.status-pipe/${WORKER_LOG_DIR}/worker-853.log`);
	});
});
