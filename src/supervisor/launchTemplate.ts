/**
 * Launch-config template substitution (design/09-launch-and-supervision.md).
 *
 * Exactly ONE token is supported — `%home%`, the user's home directory — so a
 * committed `launch.json` need not bake in a machine-specific absolute path.
 * The syntax is deliberately NOT shell-style `${...}`: a bare `%home%` can't be
 * mistaken for shell expansion, so nobody expects `${VAR}`, `${VAR:-default}`,
 * or command substitution to work. If we ever add tokens, they stay `%name%`.
 *
 * Substitution runs at spawn time, on the path-bearing fields (command, args,
 * cwd, env values) — AFTER trust approval, which hashes the raw committed form,
 * so an approval stays valid and portable regardless of whose home it resolves
 * to.
 */

import * as path from 'path';

import { LaunchAgent, WORKER_ID } from '../protocol/types';
import { SpawnRequest } from './agentRunner';

export function substituteHome(value: string, home: string): string {
	return value.replaceAll('%home%', home);
}

/**
 * Worker-only tokens, resolved by the supervisor per dispatched item BEFORE the
 * request reaches the spawner (which still resolves %home%): `%prompt%` is the
 * worker's `claude -p` argument, `%worktree%` its cwd. Both come from the
 * planner's dispatch item — the supervisor never builds them.
 */
function substituteWorker(value: string, prompt: string, worktree: string): string {
	return value.replaceAll('%prompt%', prompt).replaceAll('%worktree%', worktree);
}

/** Resolve %prompt%/%worktree% in a worker template for one dispatched item. */
export function resolveWorkerRequest(template: SpawnRequest, prompt: string, worktree: string): SpawnRequest {
	return {
		command: substituteWorker(template.command, prompt, worktree),
		args: template.args.map((arg) => substituteWorker(arg, prompt, worktree)),
		cwd: workerCwd(substituteWorker(template.cwd, prompt, worktree), worktree),
		env: Object.fromEntries(Object.entries(template.env).map(([k, v]) => [k, substituteWorker(v, prompt, worktree)])),
		// stdin can carry the prompt for backends that read it there (design/09),
		// so it gets the worker tokens too (%home% is still left — it's prompt text).
		stdin: substituteWorker(template.stdin, prompt, worktree),
	};
}

/**
 * A worker must run inside its dispatched worktree. A relative (or empty)
 * template cwd is resolved against the worktree so the worker never lands in
 * the extension host's cwd. An absolute path, or a %home%-anchored one (still
 * a token here — the spawner resolves %home% to an absolute path), is left
 * untouched: resolving the latter against the worktree would corrupt it.
 */
function workerCwd(cwd: string, worktree: string): string {
	if (path.isAbsolute(cwd) || cwd.startsWith('%home%')) return cwd;
	return path.resolve(worktree, cwd);
}

/**
 * Resolve a launch entry's cwd at install time. A scheduled agent's relative
 * cwd is resolved against the repo root; the worker template keeps its raw cwd
 * (`%worktree%`, resolved per dispatched item), and a `%home%`-anchored cwd is
 * left for the spawner — joining it onto the root would corrupt it.
 */
export function resolveAgentCwd(root: string, agent: LaunchAgent): string {
	if (agent.id === WORKER_ID || agent.cwd.startsWith('%home%')) return agent.cwd;
	return path.resolve(root, agent.cwd);
}

/** Return a copy of the request with `%home%` resolved in command/args/cwd/env. */
export function resolveLaunchTemplates(request: SpawnRequest, home: string): SpawnRequest {
	return {
		command: substituteHome(request.command, home),
		args: request.args.map((arg) => substituteHome(arg, home)),
		cwd: substituteHome(request.cwd, home),
		env: Object.fromEntries(Object.entries(request.env).map(([k, v]) => [k, substituteHome(v, home)])),
		stdin: request.stdin,
	};
}
