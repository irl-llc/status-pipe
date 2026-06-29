/**
 * Unit tests for host/nodeSpawner.ts — the production child_process spawner.
 *
 * The load-bearing guarantee is its onExit ordering: Node fires a child's
 * 'exit' before its stdout/stderr pipes flush their final 'data', so the
 * spawner completes on 'close' (post-drain) instead. WorkerRunner closes the
 * persisted worker log in onExit, so without this a crashed worker's last
 * output would be dropped from disk (#58). These tests spawn a real process to
 * lock that contract in.
 */

import assert from 'node:assert/strict';

import { ProcessEvents, SpawnRequest } from '../../../supervisor/supervisedRunner';
import { nodeSpawner } from '../../../host/nodeSpawner';

interface Outcome {
	output: string;
	/** A snapshot of everything received at the instant onExit fired. */
	outputAtExit: string;
	exitCode: number | null;
}

/** Run `node -e <script>` through the real spawner and resolve once it exits. */
function runNode(script: string): Promise<Outcome> {
	const request: SpawnRequest = {
		command: process.execPath,
		args: ['-e', script],
		cwd: process.cwd(),
		env: {},
		stdin: '',
	};
	return new Promise((resolve) => {
		let output = '';
		const events: ProcessEvents = {
			onOutput: (chunk) => (output += chunk),
			onExit: (exitCode) => resolve({ output, outputAtExit: output, exitCode }),
		};
		nodeSpawner(request, events);
	});
}

describe('host/nodeSpawner', function () {
	// Real `node` spawns (cold start + a 200KB pipe drain) can exceed mocha's
	// 2s default under CI/emulated load — give them headroom so they never flake.
	this.timeout(20_000);

	it('delivers a large output payload intact', async () => {
		// Sanity: a 200KB write spanning many pipe reads must arrive whole and
		// uncorrupted. The child GENERATES the payload at runtime — embedding 200KB
		// into the `-e` argument exceeds Linux's per-arg limit (MAX_ARG_STRLEN,
		// ~128KB) and spawns E2BIG, even though macOS's larger limit lets it through.
		const size = 200_000;
		const expected = 'TAIL-' + 'x'.repeat(size) + '-END';
		const { output, exitCode } = await runNode(`process.stdout.write('TAIL-' + 'x'.repeat(${size}) + '-END');`);
		assert.equal(exitCode, 0);
		assert.equal(output, expected);
	});

	it("captures output written to the pipe AFTER the child exits (completes on 'close', not 'exit')", async () => {
		// The load-bearing contract for #58: a crashed worker's stdout fd can be
		// held open by a surviving grandchild that writes (and our log must
		// capture) AFTER the child itself has exited. Node fires the child's 'exit'
		// at that point but its stdout pipe is still open, so output is still in
		// flight — completing on 'exit' would lose this tail; completing on 'close'
		// (post-drain) keeps it. This child exits immediately after detaching a
		// grandchild that inherits stdout and writes the tail a beat later.
		const grandchild = `setTimeout(() => process.stdout.write('TAIL-END'), 200);`;
		const script = `
			const cp = require('child_process');
			process.stdout.write('HEAD-');
			cp.spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}],
				{ detached: true, stdio: ['ignore', 1, 'ignore'] }).unref();
			process.exit(0);
		`;
		const { outputAtExit, exitCode } = await runNode(script);
		assert.equal(exitCode, 0);
		// 'exit' completion would snapshot only 'HEAD-'; 'close' waits for the
		// grandchild to write the tail and close the fd.
		assert.equal(outputAtExit, 'HEAD-TAIL-END', 'post-exit pipe output was lost — spawner completed before drain');
	});

	it('captures stderr written immediately before a nonzero exit', async () => {
		const { outputAtExit, exitCode } = await runNode(`process.stderr.write('boom\\n'); process.exit(3);`);
		assert.equal(exitCode, 3);
		assert.equal(outputAtExit, 'boom\n');
	});

	it('reports onExit(127) for a command that never spawns', async () => {
		const request: SpawnRequest = {
			command: 'definitely-not-a-real-binary-xyz',
			args: [],
			cwd: process.cwd(),
			env: {},
			stdin: '',
		};
		const code = await new Promise<number | null>((resolve) => {
			nodeSpawner(request, { onOutput: () => undefined, onExit: resolve });
		});
		assert.equal(code, 127);
	});
});
