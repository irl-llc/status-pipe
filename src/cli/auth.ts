/**
 * Standalone forge-auth resolution (#39) — the CLI's own credential chain, NOT
 * the extension's VS Code auth provider. Order mirrors the extension's minus the
 * editor-only step:
 *   GITHUB_TOKEN / GH_TOKEN env → `gh auth token` → `git credential fill`.
 *
 * Deliberately NO "token in config.json": config.json is committed, and a token
 * in version control is a credential leak. Headless CI/cron boxes set an env
 * var or have `gh`/the git credential helper configured — the cases this chain
 * already covers. Returns null when nothing resolves; the caller turns that into
 * a clear "no GitHub credentials" exit, never an interactive prompt.
 */

import { execFile } from 'child_process';

import { fillGitCredential, hostOfUrl } from '../forge/gitCredential';

function fromEnv(env: NodeJS.ProcessEnv): string | null {
	return env.GITHUB_TOKEN || env.GH_TOKEN || null;
}

function ghCliToken(): Promise<string | null> {
	return new Promise((resolve) => {
		execFile('gh', ['auth', 'token'], { timeout: 5000 }, (err, stdout) => {
			resolve(err ? null : stdout.trim() || null);
		});
	});
}

/** First credential that resolves, or null. `baseUrl` keys the git credential helper. */
export async function resolveGithubToken(
	baseUrl: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
	const fromVar = fromEnv(env);
	if (fromVar) return fromVar;
	const fromGh = await ghCliToken();
	if (fromGh) return fromGh;
	const cred = await fillGitCredential(hostOfUrl(baseUrl));
	return cred?.password ?? null;
}
