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

import { GitPort } from './ports';

const run = promisify(execFile);

export function createGitPort(repoRoot: string): GitPort {
	return { ensureWorktree: (slug) => ensureWorktree(repoRoot, slug) };
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
