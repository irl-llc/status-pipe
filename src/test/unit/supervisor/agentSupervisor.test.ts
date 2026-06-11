/**
 * Unit tests for supervisor/agentSupervisor.ts — fleet supervision: runner
 * installation, parking via orchestrator files, wake triggers, recheck
 * timers, control routing, and the enabled/maxRestarts settings.
 */

import assert from 'node:assert/strict';

import { LaunchAgent, OrchestratorFile, ParkedState } from '../../../protocol/types';
import { AgentSupervisor, SupervisorSettings } from '../../../supervisor/agentSupervisor';
import { FakeSpawner } from '../helpers/fakeSpawner';
import { ManualClock } from '../helpers/manualClock';

const REPO = '/work/repo';

function agent(overrides: Partial<LaunchAgent> = {}): LaunchAgent {
	return {
		id: 'orc',
		title: 'Orchestrator',
		command: 'claude',
		args: [],
		stdin: '',
		cwd: REPO,
		env: {},
		mode: 'tick',
		intervalMinutes: 10,
		timeoutMinutes: 5,
		...overrides,
	};
}

function orchestratorFile(parked: ParkedState | null, lastPassFinishedAt: string | null = null): OrchestratorFile {
	return {
		schemaVersion: 1,
		repo: 'repo',
		passCount: 1,
		lastPassStartedAt: null,
		lastPassFinishedAt,
		staleWorkerMinutes: null,
		parked,
		note: null,
	};
}

const PARKED: ParkedState = { since: '2026-06-01T00:00:00Z', reason: 'all work waiting on you', recheckAfter: null };

interface Harness {
	clock: ManualClock;
	spawner: FakeSpawner;
	supervisor: AgentSupervisor;
	logs: string[];
}

function makeSupervisor(settings: Partial<SupervisorSettings> = {}): Harness {
	const clock = new ManualClock();
	const spawner = new FakeSpawner();
	const logs: string[] = [];
	const supervisor = new AgentSupervisor(
		{
			spawn: spawner.spawn,
			now: () => clock.now,
			schedule: clock.schedule,
			log: (repoRoot, agentId, line) => logs.push(`${repoRoot}:${agentId}:${line}`),
			onStateChange: () => undefined,
		},
		{ enabled: true, pauseWhenIdle: false, maxRestarts: 3, ...settings },
	);
	return { clock, spawner, supervisor, logs };
}

/** start → clean exit, leaving the repo's single runner scheduled. */
function park(h: Harness): void {
	h.supervisor.control(REPO, 'orc', 'start');
	h.spawner.exitLast(0);
	h.supervisor.noteOrchestrator(REPO, orchestratorFile(PARKED));
}

describe('supervisor/agentSupervisor', () => {
	describe('setAgents', () => {
		it('installs one runner per agent', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [agent(), agent({ id: 'reviewer', title: 'Reviewer' })]);
			const states = h.supervisor.states();
			assert.deepEqual(
				states.map((s) => s.agentId),
				['orc', 'reviewer'],
			);
			assert.deepEqual(
				states.map((s) => s.state),
				['stopped', 'stopped'],
			);
		});

		it('disposes old runners when re-installed', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [agent()]);
			h.supervisor.control(REPO, 'orc', 'start');
			assert.equal(h.spawner.requests.length, 1);

			h.supervisor.setAgents(REPO, [agent({ id: 'reviewer' })]);
			assert.equal(h.spawner.kills, 1); // the running old agent was killed
			assert.deepEqual(
				h.supervisor.states().map((s) => s.agentId),
				['reviewer'],
			);
		});

		it('installs nothing when launching is disabled', () => {
			const h = makeSupervisor({ enabled: false });
			h.supervisor.setAgents(REPO, [agent()]);
			assert.deepEqual(h.supervisor.states(), []);
		});
	});

	describe('parking', () => {
		it('noteOrchestrator parked makes scheduled runners show parked', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [agent()]);
			park(h);
			assert.equal(h.supervisor.states()[0].state, 'parked');
		});

		it('noteAckCreated clears parking and launches immediately', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [agent()]);
			park(h);
			h.supervisor.noteAckCreated(REPO);
			assert.equal(h.supervisor.states()[0].state, 'running');
			assert.equal(h.spawner.requests.length, 2);
			assert.ok(h.logs.some((l) => l.includes('wake: ack created')));
		});

		it('noteBacklogChanged wakes the same way', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [agent()]);
			park(h);
			h.supervisor.noteBacklogChanged(REPO);
			assert.equal(h.spawner.requests.length, 2);
		});

		it('noteOrchestrator parked stops a RUNNING daemon and an ack relaunches it', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [agent({ id: 'daemon', mode: 'daemon' })]);
			h.supervisor.control(REPO, 'daemon', 'start');
			assert.equal(h.supervisor.states()[0].state, 'running');

			h.supervisor.noteOrchestrator(REPO, orchestratorFile(PARKED));
			assert.equal(h.spawner.kills, 1);
			assert.equal(h.supervisor.states()[0].state, 'parked');
			assert.equal(h.supervisor.states()[0].detail, 'all work waiting on you');

			h.supervisor.noteAckCreated(REPO);
			assert.equal(h.supervisor.states()[0].state, 'running');
			assert.equal(h.spawner.requests.length, 2);
		});

		it('armParkedRecheck schedules a wake at recheckAfter', async () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [agent()]);
			h.supervisor.control(REPO, 'orc', 'start');
			h.spawner.exitLast(0);
			const recheckAfter = new Date(h.clock.now + 300_000).toISOString();
			h.supervisor.noteOrchestrator(REPO, orchestratorFile({ ...PARKED, recheckAfter }));
			assert.equal(h.supervisor.states()[0].state, 'parked');

			await h.clock.advance(299_000);
			assert.equal(h.spawner.requests.length, 1);
			await h.clock.advance(1_000);
			assert.equal(h.spawner.requests.length, 2);
			assert.ok(h.logs.some((l) => l.includes('wake: recheckAfter elapsed')));
		});
	});

	describe('control routing', () => {
		it('routes start/stop/tickNow/retry to the right runner', async () => {
			const h = makeSupervisor({ maxRestarts: 1 });
			h.supervisor.setAgents(REPO, [agent()]);

			h.supervisor.control(REPO, 'orc', 'start');
			assert.equal(h.supervisor.states()[0].state, 'running');

			h.supervisor.control(REPO, 'orc', 'stop');
			assert.equal(h.supervisor.states()[0].state, 'stopped');
			assert.equal(h.spawner.kills, 1);

			h.supervisor.control(REPO, 'orc', 'tickNow');
			assert.equal(h.supervisor.states()[0].state, 'running');
			assert.equal(h.spawner.requests.length, 2);

			// maxRestarts 1: a single failure marks the runner failed…
			h.spawner.exitLast(1);
			assert.equal(h.supervisor.states()[0].state, 'failed');
			// …and retry relaunches it.
			h.supervisor.control(REPO, 'orc', 'retry');
			assert.equal(h.supervisor.states()[0].state, 'running');
			assert.equal(h.spawner.requests.length, 3);
		});

		it('ignores controls for unknown repos or agents', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [agent()]);
			h.supervisor.control('/elsewhere', 'orc', 'start');
			h.supervisor.control(REPO, 'nope', 'start');
			assert.equal(h.spawner.requests.length, 0);
		});

		it('startAll and stopAll hit every runner', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [agent(), agent({ id: 'reviewer' })]);
			h.supervisor.startAll();
			assert.equal(h.spawner.requests.length, 2);
			h.supervisor.stopAll();
			assert.deepEqual(
				h.supervisor.states().map((s) => s.state),
				['stopped', 'stopped'],
			);
		});
	});

	it('honors maxRestarts across backoff relaunches', async () => {
		const h = makeSupervisor({ maxRestarts: 2 });
		h.supervisor.setAgents(REPO, [agent()]);
		h.supervisor.control(REPO, 'orc', 'start');
		h.spawner.exitLast(1);
		assert.equal(h.supervisor.states()[0].state, 'backoff');
		await h.clock.advance(60_000);
		h.spawner.exitLast(1);
		const state = h.supervisor.states()[0];
		assert.equal(state.state, 'failed');
		assert.equal(state.detail, 'exit 1 ×2');
	});

	it('wedge-checks running daemons against lastPassFinishedAt', async () => {
		const h = makeSupervisor();
		h.supervisor.setAgents(REPO, [agent({ id: 'daemon', mode: 'daemon', intervalMinutes: 1 })]);
		h.supervisor.control(REPO, 'daemon', 'start');
		// The periodic wedge check (every 60s) kills once progress is older
		// than 2× the interval: at t=180s, now − runningSince(0) > 120s.
		await h.clock.advance(180_000);
		assert.equal(h.spawner.kills, 1);
		h.spawner.exitLast(null);
		assert.match(h.supervisor.states()[0].detail ?? '', /wedged/);
	});

	it('dispose stops runners and cancels timers', () => {
		const h = makeSupervisor();
		h.supervisor.setAgents(REPO, [agent()]);
		h.supervisor.control(REPO, 'orc', 'start');
		h.supervisor.dispose();
		assert.equal(h.spawner.kills, 1);
		assert.equal(h.clock.pendingCount(), 0);
	});
});
