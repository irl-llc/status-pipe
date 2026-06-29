/**
 * CLI discovery (src/cli/discover.ts) against real temp checkouts: protocol-dir
 * resolution, config parse, the primary-anchoring rule (run from a worktree, get
 * the primary's protocol dir), and the loud failures (no checkout, no protocol
 * dir, corrupt config).
 */

import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { discover } from '../../../cli/discover';

const run = promisify(execFile);
const CONFIG = JSON.stringify({ schemaVersion: 1, trust: { mode: 'single-maintainer', operators: ['ed'] } });

async function git(repo: string, ...args: string[]): Promise<void> {
	await run('git', ['-C', repo, ...args]);
}

async function initRepo(repo: string, remote: string | null): Promise<void> {
	await git(repo, 'init', '-q');
	await git(repo, 'config', 'user.email', 'test@example.com');
	await git(repo, 'config', 'user.name', 'Test');
	if (remote) await git(repo, 'remote', 'add', 'origin', remote);
	await fs.writeFile(path.join(repo, 'README.md'), '# repo\n', 'utf8');
	await git(repo, 'add', '.');
	await git(repo, 'commit', '-q', '-m', 'init');
}

async function seedProtocol(repo: string, config: string | null): Promise<void> {
	const dir = path.join(repo, '.status-pipe');
	await fs.mkdir(path.join(dir, 'tickets'), { recursive: true });
	if (config !== null) await fs.writeFile(path.join(dir, 'config.json'), config, 'utf8');
}

describe('cli/discover (real temp checkouts)', () => {
	let repo: string;

	beforeEach(async () => {
		repo = await fs.mkdtemp(path.join(os.tmpdir(), 'status-pipe-cli-'));
		await initRepo(repo, 'https://github.com/acme/app.git');
	});

	afterEach(async () => {
		await fs.rm(repo, { recursive: true, force: true });
	});

	it('resolves repo root, protocol dir, remote, and parsed config', async () => {
		await seedProtocol(repo, CONFIG);
		const result = await discover(repo, null, null);
		assert.ok(result.ok);
		assert.equal(result.value.repoRoot, repo);
		assert.equal(result.value.protocolDir, path.join(repo, '.status-pipe'));
		assert.match(result.value.remoteUrl ?? '', /acme\/app/);
		assert.equal(result.value.config?.trustMode, 'single-maintainer');
	});

	it('treats an absent config.json as null config (defaults apply downstream)', async () => {
		await seedProtocol(repo, null);
		const result = await discover(repo, null, null);
		assert.ok(result.ok);
		assert.equal(result.value.config, null);
	});

	it('anchors at the primary checkout when run from a linked worktree', async () => {
		await seedProtocol(repo, CONFIG);
		const wt = path.join(repo, '.wt');
		await git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
		const result = await discover(wt, null, null);
		assert.ok(result.ok);
		// A worktree's gitdir pointer records the primary as a realpath, so compare
		// realpaths — on macOS the temp dir is /var → /private/var symlinked.
		assert.equal(await fs.realpath(result.value.repoRoot), await fs.realpath(repo));
		assert.equal(await fs.realpath(result.value.protocolDir), await fs.realpath(path.join(repo, '.status-pipe')));
	});

	it('honors an explicit --protocol-dir override', async () => {
		const alt = path.join(repo, 'alt-proto');
		await fs.mkdir(alt, { recursive: true });
		const result = await discover(repo, null, alt);
		assert.ok(result.ok);
		assert.equal(result.value.protocolDir, alt);
	});

	it('fails when the directory is not a git checkout', async () => {
		const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'status-pipe-bare-'));
		const result = await discover(bare, null, null);
		assert.equal(result.ok, false);
		await fs.rm(bare, { recursive: true, force: true });
	});

	it('fails when no protocol directory exists', async () => {
		const result = await discover(repo, null, null);
		assert.equal(result.ok, false);
	});

	it('fails loud on a corrupt config.json', async () => {
		await seedProtocol(repo, '{ not json');
		const result = await discover(repo, null, null);
		assert.equal(result.ok, false);
	});

	it('fails loud on a config.json read error (not ENOENT)', async () => {
		// A directory in place of the file makes readFile throw EISDIR — a non-ENOENT
		// error must fail loud, never be swallowed as "absent config" (trust gate).
		await seedProtocol(repo, null);
		await fs.mkdir(path.join(repo, '.status-pipe', 'config.json'));
		const result = await discover(repo, null, null);
		assert.equal(result.ok, false);
		assert.match(result.ok ? '' : result.message, /unreadable/);
	});
});
