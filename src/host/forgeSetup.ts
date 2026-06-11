/**
 * Per-repo forge connection (design/03-forge.md "Detection and
 * configuration" + auth orders). The explicit statusPipe.forge.type
 * setting wins; otherwise the registry matches the remote URL. Auth:
 *   GitHub:    setting → GITHUB_TOKEN → VS Code auth provider → gh CLI
 *   Bitbucket: setting → BITBUCKET_TOKEN → SecretStorage
 */

import { execFile } from 'child_process';
import * as vscode from 'vscode';

import { RepoContext } from '../discovery/repoScan';
import { BitbucketForge } from '../forge/bitbucket';
import { GithubForge } from '../forge/github';
import { RateListener, fetchHttpClient } from '../forge/http';
import { resolveForge } from '../forge/registry';
import { Forge, ForgeRepository, RepositoryId } from '../forge/types';
import { ConfigFile } from '../protocol/types';

export const BITBUCKET_TOKEN_SECRET = 'statusPipe.bitbucket.token';

export interface ForgeConnection {
	forge: Forge;
	id: RepositoryId;
	repository: ForgeRepository;
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
	const token = await resolveToken(resolved.forge.id, cfg, secrets);
	if (!token) return null;
	// A Bitbucket username/email switches authHeader to Basic (app
	// passwords / Atlassian API tokens); without it the token rides Bearer.
	const username =
		resolved.forge.id === 'bitbucket' ? cfg.get<string>('forge.bitbucket.username') || undefined : undefined;
	const repository = resolved.forge.openRepository(resolved.id, { token, username });
	return { forge: resolved.forge, id: resolved.id, repository };
}

async function resolveToken(
	forgeId: string,
	cfg: vscode.WorkspaceConfiguration,
	secrets: vscode.SecretStorage,
): Promise<string | null> {
	if (forgeId === 'github') return resolveGithubToken(cfg);
	return resolveBitbucketToken(cfg, secrets);
}

async function resolveGithubToken(cfg: vscode.WorkspaceConfiguration): Promise<string | null> {
	const fromSetting = cfg.get<string>('forge.github.token');
	if (fromSetting) return fromSetting;
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
	const session = await getGithubSession(false);
	if (session) return session.accessToken;
	return ghCliToken();
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

async function resolveBitbucketToken(
	cfg: vscode.WorkspaceConfiguration,
	secrets: vscode.SecretStorage,
): Promise<string | null> {
	const fromSetting = cfg.get<string>('forge.bitbucket.token');
	if (fromSetting) return fromSetting;
	if (process.env.BITBUCKET_TOKEN) return process.env.BITBUCKET_TOKEN;
	return (await secrets.get(BITBUCKET_TOKEN_SECRET)) ?? null;
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
