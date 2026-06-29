/**
 * The production Spawner: child_process.spawn with stdin payload support
 * (design/09-launch-and-supervision.md launcher contract). Tests inject
 * fake spawners instead.
 */

import { ChildProcess, spawn } from 'child_process';
import { homedir } from 'os';

import { ProcessEvents, Spawner } from '../supervisor/supervisedRunner';
import { resolveLaunchTemplates } from '../supervisor/launchTemplate';

/**
 * Grace window after 'exit' before we force completion when 'close' is wedged.
 * A child's stdio pipes drain in microseconds once it exits; this only matters
 * for the pathological case where a surviving grandchild inherited the fd and
 * holds it open, which would otherwise strand the runner forever.
 */
const DRAIN_GRACE_MS = 2_000;

/**
 * Deliver exactly one onExit per spawn, and only once the child's stdout/stderr
 * have drained. Node fires 'exit' when the process ends but BEFORE its stdio
 * pipes flush their final buffered 'data' — so completing on 'exit' would drop a
 * crashed worker's last output, the very telemetry the persisted worker log
 * exists to capture (#58). We therefore complete on 'close' (emitted after stdio
 * drains), fall back to a graced 'exit' so a wedged pipe can't strand the
 * runner, and to 'error' (code 127) for a process that never spawned.
 */
function wireExitOnce(child: ChildProcess, events: ProcessEvents): void {
	let exited = false;
	const exitOnce = (code: number | null): void => {
		if (exited) return;
		exited = true;
		events.onExit(code);
	};
	child.on('error', () => exitOnce(127));
	child.on('close', (code) => exitOnce(code));
	child.on('exit', (code) => setTimeout(() => exitOnce(code), DRAIN_GRACE_MS).unref?.());
}

export const nodeSpawner: Spawner = (request, events) => {
	const req = resolveLaunchTemplates(request, homedir());
	const child = spawn(req.command, req.args, {
		cwd: req.cwd,
		env: { ...process.env, ...req.env },
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	child.stdout.on('data', (chunk: Buffer) => events.onOutput(chunk.toString('utf8')));
	child.stderr.on('data', (chunk: Buffer) => events.onOutput(chunk.toString('utf8')));
	wireExitOnce(child, events);
	// A dead child surfaces via 'error'/'exit'; an unhandled EPIPE on stdin
	// would otherwise crash the extension host.
	child.stdin?.on('error', () => undefined);
	if (req.stdin) child.stdin?.write(req.stdin);
	child.stdin?.end();
	return { kill: () => child.kill('SIGTERM') };
};
