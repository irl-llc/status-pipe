/**
 * The CLI process entry — the ONE place that touches the real process (argv,
 * stdout/stderr, exit code). Everything testable lives in run.ts; this is just
 * the I/O shell, kept tiny so the binary's surface is trivial to reason about.
 * The `#!/usr/bin/env node` shebang for the npm-bin path is added by webpack's
 * BannerPlugin (a source shebang would be invalid once wrapped in the bundle).
 */

import { run } from './run';

async function main(): Promise<void> {
	try {
		const result = await run(process.argv.slice(2), { cwd: process.cwd(), env: process.env });
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.code;
	} catch (err) {
		// run() is built to return a CliResult, but a last-resort catch keeps an
		// unexpected throw from surfacing as an unhandled rejection + raw stack.
		process.stderr.write(`status-pipe: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exitCode = 1;
	}
}

void main();
