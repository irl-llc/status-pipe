/**
 * git-credential lookup (the git-spice credential model, internal/forge/gcm.go):
 * ask whatever credential helper the local git is configured with —
 * git-credential-manager, osxkeychain, gh's helper — for the forge host.
 * GIT_TERMINAL_PROMPT=0 keeps the call non-interactive: no stored credential
 * means null, never a prompt.
 */

import { execFile } from 'child_process';

export interface GitCredential {
	/** Account identifier; may be null (token-only helpers). */
	username: string | null;
	/** The access token or password. */
	password: string;
}

export function fillGitCredential(host: string, cwd?: string): Promise<GitCredential | null> {
	return new Promise((resolve) => {
		const child = execFile(
			'git',
			['credential', 'fill'],
			{ cwd, timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
			(err, stdout) => resolve(err ? null : parseCredential(stdout)),
		);
		child.stdin?.on('error', () => undefined);
		child.stdin?.write(`protocol=https\nhost=${host}\n\n`);
		child.stdin?.end();
	});
}

function parseCredential(output: string): GitCredential | null {
	const fields = new Map<string, string>();
	for (const line of output.split('\n')) {
		const eq = line.indexOf('=');
		if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
	}
	const password = fields.get('password');
	if (!password) return null;
	return { username: fields.get('username') || null, password };
}

/** The bare host of a base URL like https://github.com — credential-helper key. */
export function hostOfUrl(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}
