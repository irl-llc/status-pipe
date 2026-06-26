/**
 * Per-repo forge connection (design/03-forge.md "Detection and
 * configuration" + auth orders). The explicit statusPipe.forge.type
 * setting wins; otherwise the registry matches the remote URL. Auth
 * (the git-spice credential model — env/setting token, the local git
 * credential helper, or a tool-specific ambient source):
 *   GitHub:    setting → GITHUB_TOKEN → VS Code auth provider → gh CLI
 *              → `git credential fill` for the GitHub host
 *   Bitbucket: setting (+ username setting) → BITBUCKET_TOKEN →
 *              `git credential fill` for the Bitbucket host (username+
 *              password ⇒ Basic) → SecretStorage
 */

import { execFile } from 'child_process';
import * as vscode from 'vscode';

import { RepoContext } from '../discovery/repoScan';
import { BitbucketForge } from '../forge/bitbucket';
import { fillGitCredential, hostOfUrl } from '../forge/gitCredential';
import { GithubForge } from '../forge/github';
import { RateListener, fetchHttpClient } from '../forge/http';
import { resolveForge } from '../forge/registry';
import { Forge, ForgeAuth, ForgeInventory, ForgeRepository, RepositoryId } from '../forge/types';
import { ConfigFile } from '../protocol/types';

export const BITBUCKET_TOKEN_SECRET = 'statusPipe.bitbucket.token';

export interface ForgeConnection {
	forge: Forge;
	id: RepositoryId;
	repository: ForgeRepository;
	/** Issue inventory for the in-process planner; null when the forge has none. */
	inventory: ForgeInventory | null;
}

function settings(context: RepoContext): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('statusPipe', vscode.Uri.file(context.repoRoot));
}

export function buildForges(context: RepoContext, config: ConfigFile | null, onRateInfo: RateListener): Forge[] {
	const cfg = settings(context);
	const github = new GithubForge({
		baseUrl: cfg.get<string>('forge.github.baseUrl') || undefined,
		apiUrl: cfg.get<string>('forge.github.apiUrl') || undefined,
		http: fetchHttpClient,
		onRateInfo,
	});
	const bitbucket = new BitbucketForge({
		baseUrl: cfg.get<string>('forge.bitbucket.baseUrl') || undefined,
		apiUrl: cfg.get<string>('forge.bitbucket.apiUrl') || undefined,
		http: fetchHttpClient,
		onRateInfo,
		jiraSiteUrl: config?.jiraSiteUrl ?? cfg.get<string>('tickets.jira.siteUrl') ?? null,
	});
	return [github, bitbucket];
}

export async function connectRepo(
	context: RepoContext,
	config: ConfigFile | null,
	secrets: vscode.SecretStorage,
	onRateInfo: RateListener,
): Promise<ForgeConnection | null> {
	const cfg = settings(context);
	const forges = buildForges(context, config, onRateInfo);
	const resolved = resolveForge(forges, context.remoteUrl, cfg.get<string>('forge.type') ?? 'auto');
	if (!resolved) return null;
	const auth = await resolveAuth(resolved.forge, cfg, secrets);
	if (!auth) return null;
	const repository = resolved.forge.openRepository(resolved.id, auth);
	const inventory = resolved.forge.openInventory(resolved.id, auth);
	return { forge: resolved.forge, id: resolved.id, repository, inventory };
}

async function resolveAuth(
	forge: Forge,
	cfg: vscode.WorkspaceConfiguration,
	secrets: vscode.SecretStorage,
): Promise<ForgeAuth | null> {
	if (forge.id === 'github') {
		const token = await resolveGithubToken(cfg, forge.baseUrl);
		return token ? { token } : null;
	}
	return resolveBitbucketAuth(cfg, secrets, forge.baseUrl);
}

async function resolveGithubToken(cfg: vscode.WorkspaceConfiguration, baseUrl: string): Promise<string | null> {
	const fromSetting = cfg.get<string>('forge.github.token');
	if (fromSetting) return fromSetting;
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
	const session = await getGithubSession(false);
	if (session) return session.accessToken;
	const fromGh = await ghCliToken();
	if (fromGh) return fromGh;
	const cred = await fillGitCredential(hostOfUrl(baseUrl));
	return cred?.password ?? null;
}

export async function getGithubSession(interactive: boolean): Promise<vscode.AuthenticationSession | undefined> {
	try {
		return await vscode.authentication.getSession('github', ['repo'], {
			createIfNone: interactive,
			silent: interactive ? undefined : true,
		});
	} catch {
		return undefined;
	}
}

function ghCliToken(): Promise<string | null> {
	return new Promise((resolve) => {
		execFile('gh', ['auth', 'token'], { timeout: 5000 }, (err, stdout) => {
			resolve(err ? null : stdout.trim() || null);
		});
	});
}

/**
 * Bitbucket auth: a username (setting or credential-helper) switches the
 * client's authHeader to Basic — the app-password / Atlassian-API-token
 * form; a bare token rides Bearer (OAuth / access tokens).
 */
async function resolveBitbucketAuth(
	cfg: vscode.WorkspaceConfiguration,
	secrets: vscode.SecretStorage,
	baseUrl: string,
): Promise<ForgeAuth | null> {
	const username = cfg.get<string>('forge.bitbucket.username') || undefined;
	const fromSetting = cfg.get<string>('forge.bitbucket.token');
	if (fromSetting) return { token: fromSetting, username };
	if (process.env.BITBUCKET_TOKEN) return { token: process.env.BITBUCKET_TOKEN, username };
	const cred = await fillGitCredential(hostOfUrl(baseUrl));
	if (cred) return { token: cred.password, username: username ?? cred.username ?? undefined };
	const stored = await secrets.get(BITBUCKET_TOKEN_SECRET);
	return stored ? { token: stored, username } : null;
}

/** Interactive sign-in commands (tokens go to SecretStorage, never settings). */
export async function signInBitbucket(secrets: vscode.SecretStorage): Promise<void> {
	const token = await vscode.window.showInputBox({
		title: 'Bitbucket API token',
		prompt: 'Stored in VS Code secret storage',
		password: true,
		ignoreFocusOut: true,
	});
	if (token) {
		await secrets.store(BITBUCKET_TOKEN_SECRET, token);
		void vscode.window.showInformationMessage('Status Pipe: Bitbucket token stored.');
	}
}

export async function signInGithub(): Promise<void> {
	const session = await getGithubSession(true);
	if (session) {
		void vscode.window.showInformationMessage(`Status Pipe: signed in to GitHub as ${session.account.label}.`);
	}
}
