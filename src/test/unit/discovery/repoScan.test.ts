/**
 * Unit tests for participating-repo discovery (src/discovery/repoScan.ts)
 * against real temp-dir fixtures.
 *
 * The worktree recursion guard is the point: a worktree carries the
 * committed launch.json, and supervising it would re-orchestrate the
 * primary's backlog and mint nested worktrees every tick
 * (design/04-architecture.md "Worktree guard"). So a worktree must resolve
 * its protocol dir to the PRIMARY checkout, and must be dropped outright
 * whenever the primary itself is also scanned.
 */

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { scanForRepos } from '../../../discovery/repoScan';

const PROTOCOL_DIR_NAME = '.status-pipe';

async function makePrimaryRepo(root: string, withProtocolDir: boolean): Promise<void> {
	await fs.mkdir(path.join(root, '.git'), { recursive: true });
	const config = `[remote "origin"]\n\turl = git@github.com:acme/${path.basename(root)}.git\n`;
	await fs.writeFile(path.join(root, '.git', 'config'), config, 'utf8');
	if (withProtocolDir) {
		await fs.mkdir(path.join(root, PROTOCOL_DIR_NAME), { recursive: true });
	}
}

async function makeWorktree(root: string, primary: string): Promise<void> {
	const wtGitDir = path.join(primary, '.git', 'worktrees', path.basename(root));
	await fs.mkdir(wtGitDir, { recursive: true });
	await fs.mkdir(root, { recursive: true });
	await fs.writeFile(path.join(root, '.git'), `gitdir: ${wtGitDir}\n`, 'utf8');
}

describe('discovery/repoScan', () => {
	let tmp: string;

	before(async () => {
		tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'status-pipe-scan-')));
	});

	after(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	it('finds a repo whose root is the workspace folder itself', async () => {
		const folder = path.join(tmp, 'root-repo');
		await makePrimaryRepo(folder, true);

		const repos = await scanForRepos([folder], PROTOCOL_DIR_NAME);
		assert.deepStrictEqual(repos, [
			{
				folder,
				repoRoot: folder,
				protocolDir: path.join(folder, PROTOCOL_DIR_NAME),
				remoteUrl: 'git@github.com:acme/root-repo.git',
				role: 'primary',
				worktreeRoot: null,
			},
		]);
	});

	it('finds repos one level below the folder and ignores repos without the protocol dir', async () => {
		const folder = path.join(tmp, 'meta');
		await makePrimaryRepo(path.join(folder, 'repo1'), true);
		await makePrimaryRepo(path.join(folder, 'repo2'), false);

		const repos = await scanForRepos([folder], PROTOCOL_DIR_NAME);
		assert.strictEqual(repos.length, 1);
		assert.strictEqual(repos[0].repoRoot, path.join(folder, 'repo1'));
		assert.strictEqual(repos[0].folder, folder);
		assert.strictEqual(repos[0].role, 'primary');
	});

	it('skips hidden directories and node_modules when scanning one level below', async () => {
		const folder = path.join(tmp, 'noise');
		await fs.mkdir(folder, { recursive: true });
		await makePrimaryRepo(path.join(folder, 'node_modules', 'dep-repo'), true);
		await makePrimaryRepo(path.join(folder, '.hidden', 'hidden-repo'), true);

		assert.deepStrictEqual(await scanForRepos([folder], PROTOCOL_DIR_NAME), []);
	});

	it('resolves a lone worktree to the primary checkout and its protocol dir', async () => {
		const primary = path.join(tmp, 'wt-primary');
		const folder = path.join(tmp, 'wt-folder');
		const worktree = path.join(folder, 'feature-wt');
		await makePrimaryRepo(primary, true);
		await makeWorktree(worktree, primary);

		const repos = await scanForRepos([folder], PROTOCOL_DIR_NAME);
		assert.deepStrictEqual(repos, [
			{
				folder,
				repoRoot: primary,
				protocolDir: path.join(primary, PROTOCOL_DIR_NAME),
				remoteUrl: 'git@github.com:acme/wt-primary.git',
				role: 'worktree',
				worktreeRoot: worktree,
			},
		]);
	});

	it('drops the worktree entry when its primary is also scanned (recursion guard)', async () => {
		const primary = path.join(tmp, 'dual-primary');
		const worktree = path.join(tmp, 'dual-wt');
		await makePrimaryRepo(primary, true);
		await makeWorktree(worktree, primary);

		const repos = await scanForRepos([primary, worktree], PROTOCOL_DIR_NAME);
		assert.strictEqual(repos.length, 1);
		assert.strictEqual(repos[0].repoRoot, primary);
		assert.strictEqual(repos[0].role, 'primary');
		assert.strictEqual(repos[0].worktreeRoot, null);
	});

	it('drops the worktree regardless of scan order', async () => {
		const primary = path.join(tmp, 'order-primary');
		const worktree = path.join(tmp, 'order-wt');
		await makePrimaryRepo(primary, true);
		await makeWorktree(worktree, primary);

		const repos = await scanForRepos([worktree, primary], PROTOCOL_DIR_NAME);
		assert.strictEqual(repos.length, 1);
		assert.strictEqual(repos[0].role, 'primary');
	});

	it('ignores a worktree whose primary has no protocol dir', async () => {
		const primary = path.join(tmp, 'bare-primary');
		const worktree = path.join(tmp, 'bare-wt');
		await makePrimaryRepo(primary, false);
		await makeWorktree(worktree, primary);

		assert.deepStrictEqual(await scanForRepos([worktree], PROTOCOL_DIR_NAME), []);
	});

	it('ignores non-repo folders entirely', async () => {
		const folder = path.join(tmp, 'not-a-repo');
		await fs.mkdir(path.join(folder, PROTOCOL_DIR_NAME), { recursive: true });

		assert.deepStrictEqual(await scanForRepos([folder], PROTOCOL_DIR_NAME), []);
	});
});
