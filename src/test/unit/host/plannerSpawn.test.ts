/**
 * Unit tests for host/plannerSpawn.ts — the built-in planner Spawner: the
 * no-inventory fail-closed guard, exit codes for success/failure, and the
 * kill→immediate non-zero exit that keeps a wedged pass from stranding the
 * runner in 'running'. The pass runner is injected so the exit/kill branches
 * are deterministic; the REAL pass is covered against fs+git+fake-forge in
 * runPass.test.ts. (plannerSpawn is vscode-free despite living under host/.)
 */

import assert from 'node:assert/strict';

import { ForgeInventory } from '../../../forge/types';
import { PlannerRepo, PlannerSpawnDeps, createPlannerSpawn } from '../../../host/plannerSpawn';
import { formatPlanReport, plannerConfigFromFile } from '../../../planner/runPass';
import { PlanResult } from '../../../planner/types';
import { ProcessEvents, SpawnRequest } from '../../../supervisor/supervisedRunner';

const REPO_ROOT = '/work/repo';
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function repo(over: Partial<PlannerRepo> = {}): PlannerRepo {
	return {
		repo: 'acme/app',
		protocolDir: `${REPO_ROOT}/.status-pipe`,
		inventory: {} as ForgeInventory,
		forgeConnected: true,
		config: null,
		...over,
	};
}

function emptyResult(over: Partial<PlanResult['report']> = {}): PlanResult {
	return {
		dispatch: null,
		report: {
			refusedReason: null,
			consumedAcks: [],
			supersededAcks: [],
			orphanedAcks: [],
			staleReconciled: [],
			createdTrackingTickets: [],
			dispatched: [],
			deferred: [],
			parked: null,
			...over,
		},
	};
}

interface Captured {
	outputs: string[];
	exits: number[];
	events: ProcessEvents;
}

function capture(): Captured {
	const outputs: string[] = [];
	const exits: number[] = [];
	return {
		outputs,
		exits,
		events: { onOutput: (c: string) => outputs.push(c), onExit: (code: number | null) => exits.push(code ?? -1) },
	};
}

function deps(over: Partial<PlannerSpawnDeps> = {}): PlannerSpawnDeps {
	return { lookup: () => repo(), liveWorkerKeys: () => [], ...over };
}

function request(): SpawnRequest {
	return { command: '', args: [], cwd: REPO_ROOT, env: {}, stdin: '' };
}

describe('host/plannerSpawn', () => {
	it('skips cleanly (exit 0) — not fail — when no forge connection is available yet', () => {
		const cap = capture();
		createPlannerSpawn(deps({ lookup: () => repo({ inventory: null, forgeConnected: false }) }))(request(), cap.events);
		// exit 0 so the scheduled runner keeps polling and recovers, instead of
		// churning to backoff → failed when a forge simply isn't connected yet.
		assert.deepEqual(cap.exits, [0]);
		assert.ok(cap.outputs.join('').includes('no forge connection yet'));
	});

	it('fails (exit 1) with a cwd-specific message when the cwd matches no managed repo', () => {
		const cap = capture();
		// A null lookup is a misconfigured cwd, NOT a not-yet-connected forge — the
		// message must name the real cause, not reuse "no forge connection yet".
		createPlannerSpawn(deps({ lookup: () => null }))(request(), cap.events);
		assert.deepEqual(cap.exits, [1]);
		assert.ok(cap.outputs.join('').includes('no managed repo'));
		assert.ok(!cap.outputs.join('').includes('no forge connection'));
	});

	it('fails (exit 1) when connected to a forge with no issue inventory, pointing at type:"claude"', () => {
		const cap = capture();
		// Bitbucket/Jira connect fine but expose no issue inventory — the built-in
		// planner can't run there. Fail loud (not skip) so the operator notices and
		// switches the tick entry, instead of a forever-silent no-op.
		createPlannerSpawn(deps({ lookup: () => repo({ inventory: null, forgeConnected: true }) }))(request(), cap.events);
		assert.deepEqual(cap.exits, [1]);
		assert.ok(cap.outputs.join('').includes('no issue inventory'));
		assert.ok(cap.outputs.join('').includes('type:"claude"'));
	});

	it('runs the pass, streams its report, and exits 0 on success', async () => {
		const cap = capture();
		createPlannerSpawn(deps({ runPass: async () => emptyResult() }))(request(), cap.events);
		await tick();
		assert.deepEqual(cap.exits, [0]);
		assert.ok(cap.outputs.join('').startsWith('[planner]'));
	});

	it('exits 1 and surfaces the message when the pass throws', async () => {
		const cap = capture();
		createPlannerSpawn(
			deps({
				runPass: async () => {
					throw new Error('boom');
				},
			}),
		)(request(), cap.events);
		await tick();
		assert.deepEqual(cap.exits, [1]);
		assert.ok(cap.outputs.join('').includes('pass failed: boom'));
	});

	it('kill() settles the runner at once while the pass is still pending, ignoring its late exit', async () => {
		const cap = capture();
		let finish!: () => void;
		const pending = new Promise<PlanResult>((r) => (finish = () => r(emptyResult())));
		const handle = createPlannerSpawn(deps({ runPass: () => pending }))(request(), cap.events);
		handle.kill(); // pass still in flight (e.g. wedged on a hung git/forge call)
		assert.deepEqual(cap.exits, [1], 'runner recovers immediately, not after the pass');
		finish(); // the orphaned pass completes later…
		await tick();
		assert.deepEqual(cap.exits, [1], 'no second exit');
		assert.equal(cap.outputs.join(''), '', 'no stale report after a kill');
	});
});

// formatPlanReport / plannerConfigFromFile are pure run-log helpers; runPass.test.ts
// asserts on the structured result, so the digest text and null-config path live here.
describe('planner/runPass digest + config defaults', () => {
	it('formatPlanReport summarizes a normal pass and notes parking', () => {
		assert.match(formatPlanReport(emptyResult()), /dispatched 0, deferred 0/);
		const parked = emptyResult({ parked: { since: 'x', reason: 'idle', recheckAfter: null } });
		assert.match(formatPlanReport(parked), /— parked: idle/);
	});

	it('formatPlanReport surfaces dropped acks (superseded/orphaned) only when present', () => {
		assert.doesNotMatch(formatPlanReport(emptyResult()), /superseded|orphaned/); // clean pass: no noise
		const dropped = emptyResult({ supersededAcks: ['a1'], orphanedAcks: ['a2', 'a3'] });
		assert.match(formatPlanReport(dropped), /acks superseded 1, acks orphaned 2/);
	});

	it('formatPlanReport short-circuits on a refusal', () => {
		const refused = emptyResult({ refusedReason: 'public repo, no trust mode' });
		assert.equal(formatPlanReport(refused), '[planner] refused: public repo, no trust mode\n');
	});

	it('plannerConfigFromFile falls back to defaults when config is null', () => {
		const cfg = plannerConfigFromFile(null, REPO_ROOT);
		assert.equal(cfg.inventoryLabel, 'agent-queue');
		assert.equal(cfg.staleWorkerMinutes, 30);
		assert.ok(cfg.epicsDir.endsWith('/epics'));
		assert.deepEqual(cfg.inventoryAssignees, []);
	});
});
