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

import { SpawnRequest } from './agentRunner';

export function substituteHome(value: string, home: string): string {
	return value.replaceAll('%home%', home);
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
