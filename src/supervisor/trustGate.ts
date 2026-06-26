/**
 * Trust gating for launch entries (design/09-launch-and-supervision.md):
 * a committed file that causes process execution is an attack surface.
 * Approval is stored per content-hash of the COMPLETE entry — id, type,
 * command, args, stdin, cwd, env, lifetime — so an env override
 * (NODE_OPTIONS, PATH) or a role/default change can't ride through review
 * unseen; the dialog displays everything the hash covers. `claude`-type
 * defaults are resolved into command/args before hashing, so the operator
 * sees the actual invocation.
 */

import { createHash } from 'crypto';

import { LaunchAgent } from '../protocol/types';

/** Stable hash over every execution-relevant field of the entry. */
export function launchEntryHash(agent: LaunchAgent): string {
	const canonical = JSON.stringify({
		id: agent.id,
		type: agent.type,
		command: agent.command,
		args: agent.args,
		stdin: agent.stdin,
		cwd: agent.cwd,
		env: Object.fromEntries(Object.entries(agent.env).sort(([a], [b]) => a.localeCompare(b))),
		lifetime: agent.lifetime,
		intervalMinutes: agent.intervalMinutes,
		timeoutMinutes: agent.timeoutMinutes,
	});
	return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** The complete-entry text shown in the approval dialog. */
export function describeLaunchEntry(agent: LaunchAgent): string {
	const lines = [
		`${agent.id} — type ${agent.type}, lifetime ${agent.lifetime}`,
		commandLine(agent),
		`interval ${agent.intervalMinutes}m, timeout ${agent.timeoutMinutes}m`,
		`cwd: ${agent.cwd}`,
	];
	if (agent.stdin) lines.push(`stdin: ${agent.stdin}`);
	const env = Object.entries(agent.env);
	if (env.length > 0) lines.push(`env: ${env.map(([k, v]) => `${k}=${v}`).join(' ')}`);
	return lines.join('\n');
}

/** A built-in entry runs no external process — say so instead of a blank command. */
function commandLine(agent: LaunchAgent): string {
	if (agent.type === 'built-in') return 'in-process planner (no external command)';
	return `command: ${agent.command} ${agent.args.join(' ')}`.trim();
}
