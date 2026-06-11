/**
 * Git repository inspection without executing git (design/04-architecture.md).
 *
 * Reads .git directly: a directory means a primary checkout; a `gitdir:`
 * pointer file means a linked worktree or submodule. The worktree guard is
 * recursion safety — worktrees carry the committed launch.json, and
 * supervising one would re-orchestrate the primary's backlog and mint nested
 * worktrees every tick. Worktrees are never supervised; their protocol dir
 * resolves to the primary checkout's.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface GitCheckout {
	/** The checkout root that was inspected. */
	root: string;
	role: 'primary' | 'worktree';
	/** Primary checkout root; equals `root` for primaries. */
	primaryRoot: string;
	/** First remote URL found (origin preferred), parsed from the primary's config. */
	remoteUrl: string | null;
}

/**
 * Classifies `root` as a git checkout, or returns null when it isn't one.
 */
export async function inspectGitCheckout(root: string): Promise<GitCheckout | null> {
	const dotGit = path.join(root, '.git');
	const stat = await fs.stat(dotGit).catch(() => null);
	if (!stat) return null;
	if (stat.isDirectory()) {
		return { root, role: 'primary', primaryRoot: root, remoteUrl: await readRemoteUrl(dotGit) };
	}
	return inspectGitPointerFile(root, dotGit);
}

async function inspectGitPointerFile(root: string, dotGitFile: string): Promise<GitCheckout | null> {
	const gitdir = await readGitdirPointer(dotGitFile);
	if (!gitdir) return null;
	const resolved = path.resolve(root, gitdir);
	// Linked worktrees point at <primary>/.git/worktrees/<name>; anything
	// else (submodules point at <super>/.git/modules/<name>) is not a
	// worktree of a supervisable primary — skip it entirely.
	const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
	const idx = resolved.indexOf(marker);
	if (idx === -1) return null;
	const primaryGitDir = resolved.slice(0, idx + `${path.sep}.git`.length);
	const primaryRoot = path.dirname(primaryGitDir);
	return { root, role: 'worktree', primaryRoot, remoteUrl: await readRemoteUrl(primaryGitDir) };
}

async function readGitdirPointer(dotGitFile: string): Promise<string | null> {
	const content = await fs.readFile(dotGitFile, 'utf8').catch(() => null);
	if (!content) return null;
	const match = content.match(/^gitdir:\s*(.+)\s*$/m);
	return match ? match[1].trim() : null;
}

async function readRemoteUrl(gitDir: string): Promise<string | null> {
	const content = await fs.readFile(path.join(gitDir, 'config'), 'utf8').catch(() => null);
	return content ? parseRemoteUrl(content) : null;
}

/**
 * Extracts the origin remote URL (any remote as fallback) from git config
 * text. `url.*.insteadOf` rewrites are explicitly out of scope — raw URLs
 * are matched (design/04-architecture.md).
 */
export function parseRemoteUrl(configText: string): string | null {
	const remotes = parseRemoteSections(configText);
	return remotes.get('origin') ?? remotes.values().next().value ?? null;
}

function remoteUrlFromLine(line: string, currentRemote: string | null): [string, string] | null {
	if (!currentRemote) return null;
	const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
	return url ? [currentRemote, url[1]] : null;
}

function parseRemoteSections(configText: string): Map<string, string> {
	const remotes = new Map<string, string>();
	let currentRemote: string | null = null;
	for (const line of configText.split('\n')) {
		const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/);
		if (section || /^\s*\[/.test(line)) {
			currentRemote = section ? section[1] : null;
			continue;
		}
		const entry = remoteUrlFromLine(line, currentRemote);
		if (entry && !remotes.has(entry[0])) remotes.set(entry[0], entry[1]);
	}
	return remotes;
}
