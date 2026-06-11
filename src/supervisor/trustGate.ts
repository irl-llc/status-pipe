/**
 * Trust gating for launch entries (design/09-launch-and-supervision.md):
 * a committed file that causes process execution is an attack surface.
 * Approval is stored per content-hash of the COMPLETE entry — command,
 * args, stdin, cwd, env — so an env override (NODE_OPTIONS, PATH) can't
 * ride through review unseen; the dialog displays everything the hash
 * covers.
 */

import { createHash } from 'crypto';

import { LaunchAgent } from '../protocol/types';

/** Stable hash over every execution-relevant field of the entry. */
export function launchEntryHash(agent: LaunchAgent): string {
	const canonical = JSON.stringify({
		command: agent.command,
		args: agent.args,
		stdin: agent.stdin,
		cwd: agent.cwd,
		env: Object.fromEntries(Object.entries(agent.env).sort(([a], [b]) => a.localeCompare(b))),
		mode: agent.mode,
		intervalMinutes: agent.intervalMinutes,
		timeoutMinutes: agent.timeoutMinutes,
	});
	return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** The complete-entry text shown in the approval dialog. */
export function describeLaunchEntry(agent: LaunchAgent): string {
	const lines = [
		`command: ${agent.command} ${agent.args.join(' ')}`.trim(),
		`mode: ${agent.mode} (interval ${agent.intervalMinutes}m, timeout ${agent.timeoutMinutes}m)`,
		`cwd: ${agent.cwd}`,
	];
	if (agent.stdin) lines.push(`stdin: ${agent.stdin}`);
	const env = Object.entries(agent.env);
	if (env.length > 0) lines.push(`env: ${env.map(([k, v]) => `${k}=${v}`).join(' ')}`);
	return lines.join('\n');
}
