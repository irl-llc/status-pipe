/**
 * Participating-repo discovery (vscode-free core; design/04-architecture.md).
 *
 * A repo participates when `<protocolDirName>/` exists at a scanned folder
 * root or one directory level below it (covers meta-workspaces holding
 * several repos). Worktree checkouts resolve to their primary and are
 * never supervised; if the primary is itself among the scanned roots the
 * worktree entry is dropped outright.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { GitCheckout, inspectGitCheckout } from './gitRepo';

export interface RepoContext {
	/** Workspace folder this repo was discovered under. */
	folder: string;
	/** The checkout root that hosts the protocol dir (primary for worktrees). */
	repoRoot: string;
	/** Absolute path of the protocol dir at the primary checkout. */
	protocolDir: string;
	remoteUrl: string | null;
	role: 'primary' | 'worktree';
	/** For role 'worktree': the worktree checkout the user actually opened. */
	worktreeRoot: string | null;
}

export async function scanForRepos(folders: string[], protocolDirName: string): Promise<RepoContext[]> {
	const candidates = await collectCandidateRoots(folders);
	const contexts: RepoContext[] = [];
	for (const { folder, root } of candidates) {
		const ctx = await contextFor(folder, root, protocolDirName);
		if (ctx) contexts.push(ctx);
	}
	return dedupe(contexts);
}

async function collectCandidateRoots(folders: string[]): Promise<{ folder: string; root: string }[]> {
	const out: { folder: string; root: string }[] = [];
	for (const folder of folders) {
		out.push({ folder, root: folder });
		for (const child of await listSubdirs(folder)) {
			out.push({ folder, root: child });
		}
	}
	return out;
}

async function listSubdirs(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	return entries
		.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
		.map((e) => path.join(dir, e.name));
}

async function contextFor(folder: string, root: string, protocolDirName: string): Promise<RepoContext | null> {
	const checkout = await inspectGitCheckout(root);
	if (!checkout) return null;
	const protocolDir = path.join(checkout.primaryRoot, protocolDirName);
	if (!(await isDirectory(protocolDir))) return null;
	return buildContext(folder, checkout, protocolDir);
}

function buildContext(folder: string, checkout: GitCheckout, protocolDir: string): RepoContext {
	return {
		folder,
		repoRoot: checkout.primaryRoot,
		protocolDir,
		remoteUrl: checkout.remoteUrl,
		role: checkout.role,
		worktreeRoot: checkout.role === 'worktree' ? checkout.root : null,
	};
}

/**
 * One entry per primary checkout. A primary entry beats any worktree entry
 * for the same repo (the worktree folder is skipped outright when the
 * primary is also open); among worktrees of the same primary the first wins.
 */
function dedupe(contexts: RepoContext[]): RepoContext[] {
	const byRoot = new Map<string, RepoContext>();
	for (const ctx of contexts) {
		const existing = byRoot.get(ctx.repoRoot);
		if (!existing || (existing.role === 'worktree' && ctx.role === 'primary')) {
			byRoot.set(ctx.repoRoot, ctx);
		}
	}
	return [...byRoot.values()];
}

async function isDirectory(p: string): Promise<boolean> {
	const stat = await fs.stat(p).catch(() => null);
	return stat?.isDirectory() ?? false;
}
