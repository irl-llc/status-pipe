/**
 * The production Spawner: child_process.spawn with stdin payload support
 * (design/09-launch-and-supervision.md launcher contract). Tests inject
 * fake spawners instead.
 */

import { ChildProcess, spawn } from 'child_process';

import { ProcessEvents, Spawner } from '../supervisor/agentRunner';

/**
 * Node may emit both 'error' and 'exit' for one process; the runner
 * contract is one onExit per spawn.
 */
function wireExitOnce(child: ChildProcess, events: ProcessEvents): void {
	let exited = false;
	const exitOnce = (code: number | null): void => {
		if (exited) return;
		exited = true;
		events.onExit(code);
	};
	child.on('error', () => exitOnce(127));
	child.on('exit', (code) => exitOnce(code));
}

export const nodeSpawner: Spawner = (request, events) => {
	const child = spawn(request.command, request.args, {
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	child.stdout.on('data', (chunk: Buffer) => events.onOutput(chunk.toString('utf8')));
	child.stderr.on('data', (chunk: Buffer) => events.onOutput(chunk.toString('utf8')));
	wireExitOnce(child, events);
	// A dead child surfaces via 'error'/'exit'; an unhandled EPIPE on stdin
	// would otherwise crash the extension host.
	child.stdin?.on('error', () => undefined);
	if (request.stdin) child.stdin?.write(request.stdin);
	child.stdin?.end();
	return { kill: () => child.kill('SIGTERM') };
};
