/**
 * The production Spawner: child_process.spawn with stdin payload support
 * (design/09-launch-and-supervision.md launcher contract). Tests inject
 * fake spawners instead.
 */

import { spawn } from 'child_process';

import { Spawner } from '../supervisor/agentRunner';

export const nodeSpawner: Spawner = (request, events) => {
	const child = spawn(request.command, request.args, {
		cwd: request.cwd,
		env: { ...process.env, ...request.env },
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	child.stdout.on('data', (chunk: Buffer) => events.onOutput(chunk.toString('utf8')));
	child.stderr.on('data', (chunk: Buffer) => events.onOutput(chunk.toString('utf8')));
	child.on('error', () => events.onExit(127));
	child.on('exit', (code) => events.onExit(code));
	if (request.stdin) child.stdin.write(request.stdin);
	child.stdin.end();
	return { kill: () => child.kill('SIGTERM') };
};
