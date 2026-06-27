/**
 * Forge connection for the CLI: resolve the repo from its git remote, then open
 * the issue inventory the planner reads. GitHub-only for now — the deterministic
 * planner needs a first-class issue inventory (github-issues), exactly the
 * constraint the in-process built-in planner carries (host/plannerSpawn.ts).
 * Bitbucket/Jira inventory is a documented follow-up, not a silent half-feature.
 *
 * GHES / GitHub Actions: GITHUB_BASE_URL and GITHUB_API_URL override the web and
 * API endpoints (Actions sets GITHUB_API_URL natively), so the same binary works
 * against an enterprise host without a config change.
 */

import { GithubForge } from '../forge/github';
import { fetchHttpClient } from '../forge/http';
import { resolveForge } from '../forge/registry';
import { ForgeInventory } from '../forge/types';
import { resolveGithubToken } from './auth';

export interface ForgeSetup {
	inventory: ForgeInventory;
	/** `owner/name` — stamped into freshly-minted ticket files. */
	repoSlug: string;
}

export type ForgeResult = { ok: true; value: ForgeSetup } | { ok: false; message: string };

/** A GitHub forge honoring GITHUB_BASE_URL / GITHUB_API_URL overrides (GHES, Actions, tests). */
function githubForge(env: NodeJS.ProcessEnv): GithubForge {
	return new GithubForge({
		http: fetchHttpClient,
		baseUrl: env.GITHUB_BASE_URL || undefined,
		apiUrl: env.GITHUB_API_URL || undefined,
	});
}

const NO_REMOTE = 'no git remote found — cannot identify the forge repo';
const NO_CREDS = 'no GitHub credentials: set GITHUB_TOKEN, run `gh auth login`, or configure a git credential helper';
const NO_INVENTORY = 'this forge has no issue inventory; the standalone planner needs GitHub issues';
const unknownForge = (remote: string): string =>
	`unrecognized forge for remote ${remote} — the standalone planner supports GitHub`;

export async function connectForge(
	remoteUrl: string | null,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ForgeResult> {
	if (!remoteUrl) return { ok: false, message: NO_REMOTE };
	const resolved = resolveForge([githubForge(env)], remoteUrl, 'auto');
	if (!resolved) return { ok: false, message: unknownForge(remoteUrl) };
	const token = await resolveGithubToken(resolved.forge.baseUrl, env);
	if (!token) return { ok: false, message: NO_CREDS };
	const inventory = resolved.forge.openInventory(resolved.id, { token });
	if (!inventory) return { ok: false, message: NO_INVENTORY };
	return { ok: true, value: { inventory, repoSlug: resolved.id.slug } };
}
