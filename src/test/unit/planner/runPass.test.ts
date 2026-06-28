/**
 * End-to-end planner pass (src/planner/runPass.ts) wired to the REAL ports:
 * a temp git repo, a temp `.status-pipe/` dir, and a GitHub inventory served by
 * the in-process FakeForgeServer. This is the coverage the LLM `/status-pipe:
 * tick` could never have — a labeled issue in, a stamped ticket + worktree +
 * orchestrator.json dispatch out, asserted on disk.
 */

import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { FakeForgeServer } from '../../../forge/fake/fakeForgeServer';
import { FakeIssue, FakeRepoData } from '../../../forge/fake/fakeForgeData';
import { GithubForge } from '../../../forge/github';
import { fetchHttpClient } from '../../../forge/http';
import { ForgeInventory } from '../../../forge/types';
import { runPlannerPass } from '../../../planner/runPass';
import { ConfigFile } from '../../../protocol/types';

const run = promisify(execFile);
const NOW = Date.parse('2026-06-26T12:00:00Z');
const CLOCK = { now: () => NOW, iso: () => new Date(NOW).toISOString() };

async function git(repo: string, ...args: string[]): Promise<void> {
	await run('git', ['-C', repo, ...args]);
}

async function initRepo(repo: string): Promise<void> {
	await git(repo, 'init', '-q');
	await git(repo, 'config', 'user.email', 'test@example.com');
	await git(repo, 'config', 'user.name', 'Test');
	await fs.writeFile(path.join(repo, 'README.md'), '# repo\n', 'utf8');
	await git(repo, 'add', '.');
	await git(repo, 'commit', '-q', '-m', 'init');
}

function issue(over: Partial<FakeIssue> & Pick<FakeIssue, 'number' | 'title'>): FakeIssue {
	return { state: 'open', labels: ['agent-queue'], author: 'ed', assignees: ['ed'], ...over };
}

function config(over: Partial<ConfigFile> = {}): ConfigFile {
	return {
		schemaVersion: 1,
		epicsDir: 'epics',
		inventoryLabel: 'agent-queue',
		inventoryAssignees: [],
		ticketSource: 'github-issues',
		jiraSiteUrl: null,
		jiraProjectKey: null,
		staleWorkerMinutes: 30,
		trustMode: 'single-maintainer',
		trustOperators: [],
		reviewGateRequireCiGreen: true,
		reviewGateWaitForBots: [],
		reviewGateBotWaitMaxMinutes: 30,
		...over,
	};
}

async function readJson(p: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(p, 'utf8'));
}

describe('planner/runPass (real fs + git + fake forge)', () => {
	let repoRoot: string;
	let protocolDir: string;
	let server: FakeForgeServer;
	let inventory: ForgeInventory;

	async function start(data: Partial<FakeRepoData>): Promise<void> {
		server = new FakeForgeServer({ slug: 'acme/app', viewerLogin: 'ed', prs: [], visibility: 'private', ...data });
		const baseUrl = await server.start();
		const forge = new GithubForge({ apiUrl: baseUrl, http: fetchHttpClient });
		const inv = forge.openInventory(forge.repositoryId('acme/app'), { token: 't' });
		assert.ok(inv);
		inventory = inv;
	}

	beforeEach(async () => {
		repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'status-pipe-pass-'));
		protocolDir = path.join(repoRoot, '.status-pipe');
		await fs.mkdir(protocolDir, { recursive: true });
		await initRepo(repoRoot);
	});

	afterEach(async () => {
		await server.stop();
		await fs.rm(repoRoot, { recursive: true, force: true });
	});

	it('dispatches a labeled issue: stamps the ticket, creates a worktree, writes orchestrator.json', async () => {
		await start({ issues: [issue({ number: 19, title: 'Wire the queue' })] });

		const result = await runPlannerPass({
			repo: 'acme/app',
			repoRoot,
			protocolDir,
			inventory,
			config: config(),
			liveWorkerKeys: [],
			clock: CLOCK,
		});

		// Plan result names the dispatch.
		assert.equal(result.dispatch?.items.length, 1);
		assert.equal(result.dispatch?.items[0].key, '19');
		assert.match(result.dispatch?.items[0].prompt ?? '', /work-ticket 19/);

		// orchestrator.json on disk carries the dispatch + incremented pass count.
		const orch = await readJson(path.join(protocolDir, 'orchestrator.json'));
		assert.equal(orch.passCount, 1);
		assert.equal((orch.dispatch as { items: unknown[] }).items.length, 1);

		// The ticket file was minted and stamped with a running worker.
		const ticket = await readJson(path.join(protocolDir, 'tickets', '19.json'));
		assert.equal(ticket.title, 'Wire the queue');
		assert.equal((ticket.worker as { status: string }).status, 'running');

		// The worktree exists on its branch.
		const wt = path.join(repoRoot, '.claude', 'worktrees', 'ticket-19');
		assert.ok((await fs.stat(wt)).isDirectory());
	});

	it('refuses on a public repo with no declared trust mode (fail closed)', async () => {
		await start({ visibility: 'public', issues: [issue({ number: 19, title: 'x' })] });
		const result = await runPlannerPass({
			repo: 'acme/app',
			repoRoot,
			protocolDir,
			inventory,
			config: config({ trustMode: null }),
			liveWorkerKeys: [],
			clock: CLOCK,
		});
		assert.equal(result.dispatch, null);
		assert.match(result.report.refusedReason ?? '', /public repo/);
		// Nothing written.
		await assert.rejects(fs.stat(path.join(protocolDir, 'tickets', '19.json')));
	});

	it('does not re-dispatch a key that already has a live worker', async () => {
		await start({ issues: [issue({ number: 19, title: 'x' })] });
		const result = await runPlannerPass({
			repo: 'acme/app',
			repoRoot,
			protocolDir,
			inventory,
			config: config(),
			liveWorkerKeys: ['19'],
			clock: CLOCK,
		});
		assert.equal(result.dispatch, null);
	});
});
