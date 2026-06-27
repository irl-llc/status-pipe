/**
 * Filesystem/git-backed GitPort (plugin/commands/tick.md Step 4): each work
 * item runs in its own linked worktree under `<repoRoot>/.claude/worktrees/
 * <slug>` on a branch named for the slug. Idempotent — a slug whose worktree
 * already exists is returned as-is, so re-dispatch across passes is free. This
 * is the first git command the extension itself runs.
 */

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';

import { GitPort, WorktreeInfo } from './ports';

const run = promisify(execFile);

export function createGitPort(repoRoot: string): GitPort {
	return {
		ensureWorktree: (slug) => ensureWorktree(repoRoot, slug),
		listWorktrees: () => listWorktrees(repoRoot),
		removeWorktree: (slug) => removeWorktree(repoRoot, slug),
	};
}

async function ensureWorktree(repoRoot: string, slug: string): Promise<string> {
	const worktreesDir = path.join(repoRoot, '.claude', 'worktrees');
	const worktree = path.join(worktreesDir, slug);
	// The slug feeds a filesystem path AND a git branch name, and it originates
	// from operator-authored epic filenames / forge keys. Require it to land as
	// a direct child of the worktrees dir: a crafted slug ('../…', 'a/b') would
	// otherwise let path.join escape the tree. (git rejects the rest.)
	if (path.dirname(worktree) !== worktreesDir) {
		throw new Error(`unsafe worktree slug ${JSON.stringify(slug)}`);
	}
	// A bare directory is not proof of a worktree — a linked worktree carries a
	// `.git` gitlink file. A stray or half-created dir (no gitlink) is removed so
	// it can be recreated cleanly, rather than handed to a worker as if isolated
	// or left to fail `worktree add` (which rejects a non-empty existing path).
	if (await exists(path.join(worktree, '.git'))) return worktree;
	if (await exists(worktree)) await fs.rm(worktree, { recursive: true, force: true });
	await fs.mkdir(worktreesDir, { recursive: true });
	// Drop stale registrations: a worktree dir removed by hand (without
	// `git worktree remove`) leaves metadata that makes `add` fail outright.
	await git(repoRoot, ['worktree', 'prune']);
	// New branches fork off HEAD — the primary checkout's current commit, which is
	// the integration base when the operator runs the planner from main / the
	// stack tip (plugin/commands/tick.md). An existing branch is reattached, unless
	// it is already checked out elsewhere — attachExistingBranch rejects that.
	if (await branchExists(repoRoot, slug)) {
		await attachExistingBranch(repoRoot, worktree, slug);
	} else {
		await git(repoRoot, ['worktree', 'add', '-b', slug, worktree, 'HEAD']);
	}
	return worktree;
}

/**
 * Remove `slug`'s worktree, leaving the branch for reattachment. Prune first so a
 * hand-deleted dir's stale registration can't fail the remove; a registered
 * worktree (`.git` gitlink) goes through `worktree remove --force` (it may carry a
 * crashed worker's scratch — the durable work is on the branch, not here), a bare
 * stray dir is just unlinked, and a missing path is a clean no-op.
 */
async function removeWorktree(repoRoot: string, slug: string): Promise<void> {
	const worktreesDir = path.join(repoRoot, '.claude', 'worktrees');
	const worktree = path.join(worktreesDir, slug);
	if (path.dirname(worktree) !== worktreesDir) {
		throw new Error(`unsafe worktree slug ${JSON.stringify(slug)}`);
	}
	await git(repoRoot, ['worktree', 'prune']);
	if (await exists(path.join(worktree, '.git'))) {
		await git(repoRoot, ['worktree', 'remove', '--force', worktree]);
	} else if (await exists(worktree)) {
		await fs.rm(worktree, { recursive: true, force: true });
	}
}

/** Linked worktrees that live under `<repoRoot>/.claude/worktrees/` (the GC sweep's universe). */
async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
	const { stdout } = await git(repoRoot, ['worktree', 'list', '--porcelain']);
	const worktreesDir = await canonical(path.join(repoRoot, '.claude', 'worktrees'));
	const out: WorktreeInfo[] = [];
	for (const block of stdout.split('\n\n')) {
		const info = await managedWorktree(block, worktreesDir);
		if (info) out.push(info);
	}
	return out;
}

/**
 * One porcelain record → WorktreeInfo, kept only when its canonical parent dir is
 * EXACTLY `worktreesDir`. Comparing resolved paths (not a raw `.claude/worktrees`
 * substring) is symlink-agnostic — git may report `/private/var/…` where the planner
 * holds `/var/…` — and won't mistake a repo that itself sits under some *other*
 * `.claude/worktrees/` for a managed child (which the GC would then try to remove).
 */
async function managedWorktree(block: string, worktreesDir: string): Promise<WorktreeInfo | null> {
	const parsed = parseWorktreeBlock(block);
	if (!parsed) return null; // the primary checkout / foreign worktrees
	if (path.dirname(await canonical(parsed.path)) !== worktreesDir) return null;
	return { slug: path.basename(parsed.path), path: parsed.path, branch: parsed.branch };
}

/** One porcelain record → its worktree path and branch (null when the block has no worktree line). */
function parseWorktreeBlock(block: string): { path: string; branch: string | null } | null {
	const lines = block.split('\n');
	const wtLine = lines.find((l) => l.startsWith('worktree '));
	if (!wtLine) return null;
	const wtPath = wtLine.slice('worktree '.length);
	const branchLine = lines.find((l) => l.startsWith('branch '));
	const branch = branchLine ? branchLine.slice('branch '.length).replace(/^refs\/heads\//, '') : null;
	return { path: wtPath, branch };
}

/** Resolved real path, falling back to a lexical resolve when the path doesn't exist yet. */
function canonical(p: string): Promise<string> {
	return fs.realpath(p).catch(() => path.resolve(p));
}

/** Reattach an existing branch, refusing a slug already checked out elsewhere. */
async function attachExistingBranch(repoRoot: string, worktree: string, slug: string): Promise<void> {
	// git refuses a second worktree on a branch already checked out — commonly the
	// primary checkout parked on a branch whose name equals this slug. Surface an
	// actionable error rather than a raw git fatal that selectAndDispatch would
	// swallow into a silently deferred-forever work item.
	if (await branchCheckedOut(repoRoot, slug)) {
		throw new Error(
			`worktree slug ${JSON.stringify(slug)} collides with an already-checked-out branch — ` +
				`rename that branch or the epic/ticket so its slug is unique`,
		);
	}
	await git(repoRoot, ['worktree', 'add', worktree, slug]);
}

/** Is `slug`'s branch already checked out by some worktree (so `add` would fail)? */
async function branchCheckedOut(repoRoot: string, slug: string): Promise<boolean> {
	const { stdout } = await git(repoRoot, ['worktree', 'list', '--porcelain']);
	return stdout.split('\n').some((line) => line.trim() === `branch refs/heads/${slug}`);
}

async function branchExists(repoRoot: string, slug: string): Promise<boolean> {
	try {
		await git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${slug}`]);
		return true;
	} catch {
		return false;
	}
}

function git(repoRoot: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return run('git', ['-C', repoRoot, ...args]);
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}
