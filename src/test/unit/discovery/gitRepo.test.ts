/**
 * Unit tests for git checkout inspection (src/discovery/gitRepo.ts) against
 * real temp-dir fixtures — no git binary involved. The worktree/submodule
 * distinction here is the first layer of the worktree recursion guard
 * (design/04-architecture.md "Worktree guard").
 */

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { inspectGitCheckout, parseRemoteUrl } from '../../../discovery/gitRepo';

const PRIMARY_CONFIG = [
	'[core]',
	'\trepositoryformatversion = 0',
	'[remote "upstream"]',
	'\turl = https://example.com/upstream/app.git',
	'[remote "origin"]',
	'\turl = git@github.com:ed-irl/app.git',
	'',
].join('\n');

async function makePrimary(root: string): Promise<void> {
	await fs.mkdir(path.join(root, '.git', 'worktrees', 'wt1'), { recursive: true });
	await fs.writeFile(path.join(root, '.git', 'config'), PRIMARY_CONFIG, 'utf8');
}

async function makePointerCheckout(root: string, gitdir: string): Promise<void> {
	await fs.mkdir(root, { recursive: true });
	await fs.writeFile(path.join(root, '.git'), `gitdir: ${gitdir}\n`, 'utf8');
}

describe('discovery/gitRepo', () => {
	describe('inspectGitCheckout', () => {
		let tmp: string;
		let primary: string;

		before(async () => {
			tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'status-pipe-git-')));
			primary = path.join(tmp, 'primary');
			await makePrimary(primary);
			await makePointerCheckout(path.join(tmp, 'wt1'), path.join(primary, '.git', 'worktrees', 'wt1'));
			await makePointerCheckout(path.join(tmp, 'sub'), path.join(tmp, 'super', '.git', 'modules', 'sub'));
			await fs.mkdir(path.join(tmp, 'plain'), { recursive: true });
		});

		after(async () => {
			await fs.rm(tmp, { recursive: true, force: true });
		});

		it('classifies a .git directory as a primary checkout with its own root', async () => {
			assert.deepStrictEqual(await inspectGitCheckout(primary), {
				root: primary,
				role: 'primary',
				primaryRoot: primary,
				remoteUrl: 'git@github.com:ed-irl/app.git',
			});
		});

		it('resolves a linked worktree pointer back to the primary root and its remote', async () => {
			const wt = path.join(tmp, 'wt1');
			assert.deepStrictEqual(await inspectGitCheckout(wt), {
				root: wt,
				role: 'worktree',
				primaryRoot: primary,
				remoteUrl: 'git@github.com:ed-irl/app.git',
			});
		});

		it('returns null for a submodule-style gitdir pointer (.git/modules/…)', async () => {
			assert.strictEqual(await inspectGitCheckout(path.join(tmp, 'sub')), null);
		});

		it('returns null for a directory without .git', async () => {
			assert.strictEqual(await inspectGitCheckout(path.join(tmp, 'plain')), null);
		});

		it('returns null for a path that does not exist', async () => {
			assert.strictEqual(await inspectGitCheckout(path.join(tmp, 'nope')), null);
		});
	});

	describe('parseRemoteUrl', () => {
		it('prefers origin over other remotes regardless of order', () => {
			assert.strictEqual(parseRemoteUrl(PRIMARY_CONFIG), 'git@github.com:ed-irl/app.git');
		});

		it('falls back to the first remote when origin is absent', () => {
			const config = ['[remote "fork"]', '\turl = https://github.com/fork/app.git', ''].join('\n');
			assert.strictEqual(parseRemoteUrl(config), 'https://github.com/fork/app.git');
		});

		it('returns an scp-like URL verbatim', () => {
			const config = ['[remote "origin"]', '\turl = git@github.com:owner/name.git', ''].join('\n');
			assert.strictEqual(parseRemoteUrl(config), 'git@github.com:owner/name.git');
		});

		it('returns an https URL verbatim', () => {
			const config = ['[remote "origin"]', '\turl = https://github.com/owner/name.git', ''].join('\n');
			assert.strictEqual(parseRemoteUrl(config), 'https://github.com/owner/name.git');
		});

		it('ignores url keys outside [remote] sections', () => {
			const config = ['[submodule "lib"]', '\turl = https://example.com/lib.git', ''].join('\n');
			assert.strictEqual(parseRemoteUrl(config), null);
		});

		it('returns null when no remote has a url', () => {
			assert.strictEqual(parseRemoteUrl('[core]\n\tbare = false\n'), null);
			assert.strictEqual(parseRemoteUrl(''), null);
		});
	});
});
