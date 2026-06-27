/**
 * End-to-end CLI run (src/cli/run.ts) wired to the REAL stack: a temp git repo,
 * a temp .status-pipe/, and a GitHub inventory served by the in-process
 * FakeForgeServer (reached via GITHUB_API_URL). Asserts the full argv → exit-code
 * contract a CI/cron caller depends on: dispatch + stamped state on disk, the
 * trust refusal as exit 1, the JSON shape, help/version/usage codes, and the
 * heartbeat-derived live-worker guard against double-dispatch.
 */

import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { run } from '../../../cli/run';
import { FakeForgeServer } from '../../../forge/fake/fakeForgeServer';
import { FakeIssue, FakeRepoData } from '../../../forge/fake/fakeForgeData';

const exec = promisify(execFile);
const NOW = Date.parse('2026-06-27T12:00:00Z');

async function git(repo: string, ...args: string[]): Promise<void> {
	await exec('git', ['-C', repo, ...args]);
}

async function initRepo(repo: string): Promise<void> {
	await git(repo, 'init', '-q');
	await git(repo, 'config', 'user.email', 'test@example.com');
	await git(repo, 'config', 'user.name', 'Test');
	await git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
	await fs.writeFile(path.join(repo, 'README.md'), '# repo\n', 'utf8');
	await git(repo, 'add', '.');
	await git(repo, 'commit', '-q', '-m', 'init');
}

function issue(over: Partial<FakeIssue> & Pick<FakeIssue, 'number' | 'title'>): FakeIssue {
	return { state: 'open', labels: ['agent-queue'], author: 'ed', assignees: ['ed'], ...over };
}

function writeConfig(protocolDir: string, trustMode: string | null): Promise<void> {
	const cfg = { schemaVersion: 1, trust: { mode: trustMode, operators: ['ed'] } };
	return fs.writeFile(path.join(protocolDir, 'config.json'), JSON.stringify(cfg), 'utf8');
}

async function readJson(p: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(p, 'utf8'));
}

describe('cli/run (real fs + git + fake forge)', () => {
	let repo: string;
	let protocolDir: string;
	let server: FakeForgeServer | undefined;
	let env: NodeJS.ProcessEnv;

	async function start(data: Partial<FakeRepoData>): Promise<void> {
		server = new FakeForgeServer({ slug: 'acme/app', viewerLogin: 'ed', prs: [], visibility: 'private', ...data });
		const baseUrl = await server.start();
		env = { GITHUB_TOKEN: 'tok', GITHUB_API_URL: baseUrl };
	}

	function ctx(): { cwd: string; env: NodeJS.ProcessEnv; now: number } {
		return { cwd: repo, env, now: NOW };
	}

	beforeEach(async () => {
		server = undefined;
		repo = await fs.mkdtemp(path.join(os.tmpdir(), 'status-pipe-clirun-'));
		protocolDir = path.join(repo, '.status-pipe');
		await fs.mkdir(path.join(protocolDir, 'tickets'), { recursive: true });
		await initRepo(repo);
	});

	afterEach(async () => {
		if (server) await server.stop();
		await fs.rm(repo, { recursive: true, force: true });
	});

	it('dispatches a labeled issue and stamps state on disk (exit 0)', async () => {
		await start({ issues: [issue({ number: 19, title: 'Wire the queue' })] });
		await writeConfig(protocolDir, 'single-maintainer');

		const result = await run(['tick'], ctx());

		assert.equal(result.code, 0);
		assert.match(result.stdout, /\[planner\] dispatched 1/);
		const orch = await readJson(path.join(protocolDir, 'orchestrator.json'));
		assert.equal((orch.dispatch as { items: unknown[] }).items.length, 1);
		const ticket = await readJson(path.join(protocolDir, 'tickets', '19.json'));
		assert.equal(ticket.repo, 'acme/app');
		assert.equal((ticket.worker as { status: string }).status, 'running');
	});

	it('emits the PlanResult as JSON under --json', async () => {
		await start({ issues: [issue({ number: 19, title: 'x' })] });
		await writeConfig(protocolDir, 'single-maintainer');

		const result = await run(['--json'], ctx());

		assert.equal(result.code, 0);
		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.dispatch.items[0].key, '19');
	});

	it('refuses a public repo with no trust mode as exit 1', async () => {
		await start({ visibility: 'public', issues: [issue({ number: 19, title: 'x' })] });
		await writeConfig(protocolDir, null);

		const result = await run(['tick'], ctx());

		assert.equal(result.code, 1);
		assert.match(result.stdout, /refused/);
		await assert.rejects(fs.stat(path.join(protocolDir, 'tickets', '19.json')));
	});

	it('does not re-dispatch a ticket whose worker is running with a fresh heartbeat', async () => {
		await start({ issues: [issue({ number: 19, title: 'x' })] });
		await writeConfig(protocolDir, 'single-maintainer');
		const fresh = {
			schemaVersion: 1,
			ticket: '19',
			repo: 'acme/app',
			title: 'x',
			slug: null,
			phase: 'implementation',
			health: 'ok',
			headline: '',
			waitingOn: null,
			prs: [],
			blockers: [],
			subTickets: [],
			agentCommentIds: [],
			history: [],
			worker: {
				status: 'running',
				taskId: null,
				startedAt: new Date(NOW).toISOString(),
				heartbeatAt: new Date(NOW).toISOString(),
			},
			updatedAt: new Date(NOW).toISOString(),
		};
		await fs.writeFile(path.join(protocolDir, 'tickets', '19.json'), JSON.stringify(fresh), 'utf8');

		const result = await run(['tick'], ctx());

		assert.equal(result.code, 0);
		assert.match(result.stdout, /dispatched 0/);
	});

	it('fails with exit 1 when no protocol dir exists', async () => {
		await start({ issues: [] });
		await fs.rm(protocolDir, { recursive: true, force: true });
		const result = await run(['tick'], ctx());
		assert.equal(result.code, 1);
		assert.match(result.stderr, /no protocol directory/);
	});

	it('returns help and version on exit 0, usage error on exit 2', async () => {
		assert.equal((await run(['--help'], ctx())).code, 0);
		assert.match((await run(['--help'], ctx())).stdout, /standalone planner/);
		assert.equal((await run(['--version'], ctx())).code, 0);
		const bad = await run(['--bogus'], ctx());
		assert.equal(bad.code, 2);
		assert.match(bad.stderr, /usage:/);
	});
});
