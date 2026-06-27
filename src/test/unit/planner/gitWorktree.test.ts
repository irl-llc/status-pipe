/**
 * GitPort (src/planner/gitWorktree.ts) against a real temp git repo: a slug
 * gets a linked worktree on its own branch under .claude/worktrees/, the call
 * is idempotent across passes, and an existing branch is reattached rather than
 * re-created.
 */

import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { createGitPort } from '../../../planner/gitWorktree';

const run = promisify(execFile);

async function git(repo: string, ...args: string[]): Promise<string> {
	const { stdout } = await run('git', ['-C', repo, ...args]);
	return stdout.trim();
}

async function initRepo(repo: string): Promise<void> {
	await git(repo, 'init', '-q');
	await git(repo, 'config', 'user.email', 'test@example.com');
	await git(repo, 'config', 'user.name', 'Test');
	await fs.writeFile(path.join(repo, 'README.md'), '# repo\n', 'utf8');
	await git(repo, 'add', '.');
	await git(repo, 'commit', '-q', '-m', 'init');
}

async function dirExists(p: string): Promise<boolean> {
	return fs.stat(p).then(
		(s) => s.isDirectory(),
		() => false,
	);
}

async function fileExists(p: string): Promise<boolean> {
	return fs.access(p).then(
		() => true,
		() => false,
	);
}

describe('planner/gitWorktree', () => {
	let repo: string;

	beforeEach(async () => {
		repo = await fs.mkdtemp(path.join(os.tmpdir(), 'status-pipe-wt-'));
		await initRepo(repo);
	});

	afterEach(async () => {
		await fs.rm(repo, { recursive: true, force: true });
	});

	it('creates a worktree on a new branch named for the slug', async () => {
		const git_ = createGitPort(repo);
		const wt = await git_.ensureWorktree('ticket-19');
		assert.equal(wt, path.join(repo, '.claude', 'worktrees', 'ticket-19'));
		assert.ok(await dirExists(wt));
		const branches = await git(repo, 'branch', '--list', 'ticket-19');
		assert.match(branches, /ticket-19/);
		const list = await git(repo, 'worktree', 'list');
		assert.match(list, /ticket-19/);
	});

	it('is idempotent — a second call returns the same path and does not throw', async () => {
		const git_ = createGitPort(repo);
		const first = await git_.ensureWorktree('ticket-19');
		const second = await git_.ensureWorktree('ticket-19');
		assert.equal(first, second);
	});

	it('reattaches an existing branch when the worktree dir was removed', async () => {
		const git_ = createGitPort(repo);
		const wt = await git_.ensureWorktree('ticket-19');
		// Tear down the worktree but keep the branch, as a crashed pass might.
		await git(repo, 'worktree', 'remove', '--force', wt);
		assert.equal(await dirExists(wt), false);
		const again = await git_.ensureWorktree('ticket-19');
		assert.equal(again, wt);
		assert.ok(await dirExists(wt));
	});

	it('refuses a slug that collides with an already-checked-out branch (clear error, not a raw git fatal)', async () => {
		const git_ = createGitPort(repo);
		// The operator runs the planner while the primary checkout sits on a branch
		// whose name byte-matches a work-item slug. git can't attach that branch to
		// a second worktree; the planner must surface why, not fail with an opaque
		// fatal that selectAndDispatch swallows into a silently deferred-forever item.
		await git(repo, 'checkout', '-q', '-b', 'ticket-19');
		await assert.rejects(git_.ensureWorktree('ticket-19'), /collides with an already-checked-out branch/);
	});

	it('recreates a worktree whose dir was deleted by hand (stale metadata pruned)', async () => {
		const git_ = createGitPort(repo);
		const wt = await git_.ensureWorktree('ticket-19');
		// Remove the dir directly, NOT via `git worktree remove`: git's metadata
		// is now stale and a plain `worktree add` would fail "already used".
		await fs.rm(wt, { recursive: true, force: true });
		const again = await git_.ensureWorktree('ticket-19');
		assert.equal(again, wt);
		assert.ok(await dirExists(wt));
	});

	it('does not treat a bare unregistered directory as a ready worktree', async () => {
		const git_ = createGitPort(repo);
		const wt = path.join(repo, '.claude', 'worktrees', 'ticket-19');
		await fs.mkdir(wt, { recursive: true }); // a stray dir — exists, but NOT a git worktree
		const result = await git_.ensureWorktree('ticket-19');
		assert.equal(result, wt);
		// It is promoted to an actual registered worktree, not returned as the bare dir.
		assert.match(await git(repo, 'worktree', 'list'), /ticket-19/);
		assert.ok(await dirExists(wt));
	});

	it('recovers a NON-EMPTY stray dir (removes it, then recreates a real worktree)', async () => {
		const git_ = createGitPort(repo);
		const wt = path.join(repo, '.claude', 'worktrees', 'ticket-19');
		await fs.mkdir(wt, { recursive: true });
		await fs.writeFile(path.join(wt, 'leftover.txt'), 'junk', 'utf8'); // non-empty → `worktree add` would fail
		const result = await git_.ensureWorktree('ticket-19');
		assert.equal(result, wt);
		assert.match(await git(repo, 'worktree', 'list'), /ticket-19/);
		assert.equal(await fileExists(path.join(wt, 'leftover.txt')), false); // stray content gone
	});

	it('rejects a slug that would escape the worktrees directory', async () => {
		const git_ = createGitPort(repo);
		await assert.rejects(git_.ensureWorktree('../../evil'), /unsafe worktree slug/);
		await assert.rejects(git_.ensureWorktree('nested/slug'), /unsafe worktree slug/);
		// A direct child with dots is fine — git allows it, so we must too.
		assert.ok(await dirExists(await git_.ensureWorktree('feature.auth')));
	});

	describe('removeWorktree', () => {
		it('removes the worktree but leaves the branch, so ensureWorktree reattaches it (the re-open round-trip)', async () => {
			const git_ = createGitPort(repo);
			const wt = await git_.ensureWorktree('ticket-19');
			await fs.writeFile(path.join(wt, 'scratch.txt'), 'wip', 'utf8'); // uncommitted scratch — --force handles it

			await git_.removeWorktree('ticket-19');
			assert.equal(await dirExists(wt), false);
			assert.doesNotMatch(await git(repo, 'worktree', 'list'), /ticket-19/);
			assert.match(await git(repo, 'branch', '--list', 'ticket-19'), /ticket-19/); // branch survives

			const again = await git_.ensureWorktree('ticket-19');
			assert.equal(again, wt);
			assert.ok(await dirExists(wt)); // reattached to the surviving branch
		});

		it('is a no-op when the worktree is already gone (idempotent)', async () => {
			const git_ = createGitPort(repo);
			await git_.removeWorktree('never-made'); // must not throw
			const wt = await git_.ensureWorktree('ticket-19');
			await git_.removeWorktree('ticket-19');
			await git_.removeWorktree('ticket-19'); // second remove is still a clean no-op
			assert.equal(await dirExists(wt), false);
		});

		it('cleans up a bare stray dir (deleted by hand, registration pruned) without a git fatal', async () => {
			const git_ = createGitPort(repo);
			const wt = await git_.ensureWorktree('ticket-19');
			await fs.rm(path.join(wt, '.git'), { force: true }); // break the gitlink → looks like a stray dir
			await git_.removeWorktree('ticket-19');
			assert.equal(await dirExists(wt), false);
		});

		it('rejects a slug that would escape the worktrees directory', async () => {
			const git_ = createGitPort(repo);
			await assert.rejects(git_.removeWorktree('../../evil'), /unsafe worktree slug/);
		});
	});

	describe('listWorktrees', () => {
		it('lists only the managed worktrees under .claude/worktrees (not the primary checkout)', async () => {
			const git_ = createGitPort(repo);
			await git_.ensureWorktree('ticket-19');
			await git_.ensureWorktree('epic-search');
			const listed = await git_.listWorktrees();
			assert.deepEqual(listed.map((w) => w.slug).sort(), ['epic-search', 'ticket-19']);
			const ticket = listed.find((w) => w.slug === 'ticket-19');
			assert.equal(ticket?.branch, 'ticket-19'); // refs/heads/ prefix stripped
			// git reports the realpath (/private/var on macOS) — assert the suffix, not the prefix.
			assert.ok(ticket?.path.endsWith(path.join('.claude', 'worktrees', 'ticket-19')));
		});

		it('is empty before any worktree is provisioned', async () => {
			assert.deepEqual(await createGitPort(repo).listWorktrees(), []);
		});

		it('drops a worktree from the listing once it is removed', async () => {
			const git_ = createGitPort(repo);
			await git_.ensureWorktree('ticket-19');
			await git_.removeWorktree('ticket-19');
			assert.deepEqual(await git_.listWorktrees(), []);
		});
	});
});
