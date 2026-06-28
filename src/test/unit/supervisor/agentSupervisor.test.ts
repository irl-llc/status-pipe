/**
 * Unit tests for supervisor/agentSupervisor.ts — fleet supervision: runner
 * installation, parking via orchestrator files, wake triggers, recheck
 * timers, control routing, and the enabled/maxRestarts settings.
 */

import assert from 'node:assert/strict';

import { DispatchItem, LaunchAgent, OrchestratorFile, ParkedState } from '../../../protocol/types';
import { AgentSupervisor, SupervisorSettings } from '../../../supervisor/agentSupervisor';
import { FakeSpawner } from '../helpers/fakeSpawner';
import { ManualClock } from '../helpers/manualClock';

const REPO = '/work/repo';

function agent(overrides: Partial<LaunchAgent> = {}): LaunchAgent {
	return {
		id: 'orc',
		title: 'Orchestrator',
		type: 'exec',
		command: 'claude',
		args: [],
		stdin: '',
		cwd: REPO,
		env: {},
		lifetime: 'scheduled',
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
		dispatch: null,
		note: null,
	};
}

const PARKED: ParkedState = { since: '2026-06-01T00:00:00Z', reason: 'all work waiting on you', recheckAfter: null };

interface Harness {
	clock: ManualClock;
	spawner: FakeSpawner;
	supervisor: AgentSupervisor;
	logs: string[];
	/** Lines teed to each worker's disk sink, keyed by `repoRoot::key`. */
	workerLogs: Map<string, string[]>;
}

function makeSupervisor(settings: Partial<SupervisorSettings> = {}): Harness {
	const clock = new ManualClock();
	const spawner = new FakeSpawner();
	const logs: string[] = [];
	const workerLogs = new Map<string, string[]>();
	const supervisor = new AgentSupervisor(
		{
			spawn: spawner.spawn,
			now: () => clock.now,
			schedule: clock.schedule,
			log: (repoRoot, agentId, line) => logs.push(`${repoRoot}:${agentId}:${line}`),
			openWorkerLog: (repoRoot, key) => {
				const lines: string[] = [];
				workerLogs.set(`${repoRoot}::${key}`, lines);
				return { write: (line) => lines.push(line), close: () => undefined };
			},
			onStateChange: () => undefined,
		},
		{ enabled: true, pauseWhenIdle: false, maxRestarts: 3, ...settings },
	);
	return { clock, spawner, supervisor, logs, workerLogs };
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
			h.supervisor.setAgents(REPO, [agent({ id: 'daemon', lifetime: 'daemon' })]);
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
		h.supervisor.setAgents(REPO, [agent({ id: 'daemon', lifetime: 'daemon', intervalMinutes: 1 })]);
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

	describe('worker dispatch', () => {
		function workerAgent(overrides: Partial<LaunchAgent> = {}): LaunchAgent {
			return agent({
				id: 'worker',
				title: 'Worker',
				args: ['-p', '%prompt%'],
				cwd: '%worktree%',
				...overrides,
			});
		}

		function item(key: string): DispatchItem {
			return { kind: 'ticket', key, prompt: `/status-pipe:work-ticket ${key}`, worktree: `/wt/${key}` };
		}

		function dispatched(keys: string[], maxConcurrent = keys.length, passCount: number | null = 1): OrchestratorFile {
			return { ...orchestratorFile(null), passCount, dispatch: { maxConcurrent, items: keys.map(item) } };
		}

		it('spawns one worker process per dispatch item, resolving prompt/worktree', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [agent(), workerAgent()]);
			h.supervisor.noteOrchestrator(REPO, dispatched(['19', '20']));
			assert.equal(h.spawner.requests.length, 2);
			assert.deepEqual(h.spawner.requests[0].args, ['-p', '/status-pipe:work-ticket 19']);
			assert.equal(h.spawner.requests[0].cwd, '/wt/19');
		});

		it('opens a per-key disk log and tees the worker output into it', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [workerAgent()]);
			h.supervisor.noteOrchestrator(REPO, dispatched(['19']));
			h.spawner.outputLast('{"type":"assistant"}');
			const lines = h.workerLogs.get(`${REPO}::19`);
			assert.ok(lines, 'expected a disk sink opened for worker 19');
			assert.ok(lines.some((l) => l.includes('worker 19 started')));
			assert.ok(lines.includes('{"type":"assistant"}'));
		});

		it('dedups by key while a worker is still alive (even across a new pass)', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [workerAgent()]);
			h.supervisor.noteOrchestrator(REPO, dispatched(['19'], 1, 1));
			h.supervisor.noteOrchestrator(REPO, dispatched(['19'], 1, 2)); // next pass, worker still alive
			assert.equal(h.spawner.requests.length, 1);
		});

		it('caps live workers at the plan maxConcurrent', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [workerAgent()]);
			h.supervisor.noteOrchestrator(REPO, dispatched(['19', '20', '21'], 2));
			assert.equal(h.spawner.requests.length, 2);
		});

		it('re-dispatches a key after its worker exits when a NEW pass re-lists it', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [workerAgent()]);
			h.supervisor.noteOrchestrator(REPO, dispatched(['19'], 1, 1));
			h.spawner.exitLast(0);
			h.supervisor.noteOrchestrator(REPO, dispatched(['19'], 1, 2)); // next pass re-lists 19
			assert.equal(h.spawner.requests.length, 2);
		});

		it('does NOT re-spawn an exited key on a stale re-read of the same dispatch plan', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [workerAgent()]);
			h.supervisor.noteOrchestrator(REPO, dispatched(['19'], 1, 1));
			h.spawner.exitLast(0); // worker 19 finishes and writes its ticket…
			// …which the host watcher re-feeds as the SAME pass's orchestrator file.
			// Without a per-pass guard this would re-spawn the already-done worker.
			h.supervisor.noteOrchestrator(REPO, dispatched(['19'], 1, 1));
			assert.equal(h.spawner.requests.length, 1);
		});

		it('acts once on a passCount-less plan (never-reconciled ≠ reconciled-null)', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [workerAgent()]);
			// A corrupt/hand-edited orchestrator with no passCount must still spawn
			// once (not be silently dropped by colliding with the null initializer)…
			h.supervisor.noteOrchestrator(REPO, dispatched(['19'], 1, null));
			assert.equal(h.spawner.requests.length, 1);
			// …and a re-read of that same passCount-less plan must not re-spawn it.
			h.supervisor.noteOrchestrator(REPO, dispatched(['19'], 1, null));
			assert.equal(h.spawner.requests.length, 1);
		});

		it('kills a worker that exceeds its timeout', async () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [workerAgent({ timeoutMinutes: 5 })]);
			h.supervisor.noteOrchestrator(REPO, dispatched(['19']));
			await h.clock.advance(5 * 60_000);
			assert.equal(h.spawner.kills, 1);
		});

		it('logs and spawns nothing when no worker template is declared', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [agent()]);
			h.supervisor.noteOrchestrator(REPO, dispatched(['19']));
			assert.equal(h.spawner.requests.length, 0);
			// Logged to the 'worker' channel (findable), not a tick channel.
			assert.ok(
				h.logs.some((l) => l.startsWith(`${REPO}:worker:`) && l.includes("no approved launch entry with id 'worker'")),
			);
		});

		it('does not spawn workers when the supervisor is disabled', () => {
			const h = makeSupervisor({ enabled: false });
			h.supervisor.setAgents(REPO, [workerAgent()]);
			h.supervisor.noteOrchestrator(REPO, dispatched(['19']));
			assert.equal(h.spawner.requests.length, 0);
		});

		it('reconciles a dispatch fed while DISABLED once enabled and re-fed (not stranded as done)', () => {
			const h = makeSupervisor({ enabled: false });
			h.supervisor.setAgents(REPO, [workerAgent()]); // worker template recorded even while disabled
			h.supervisor.noteOrchestrator(REPO, dispatched(['19']));
			assert.equal(h.spawner.requests.length, 0); // disabled: nothing spawns — and the pass is NOT marked reconciled
			h.supervisor.updateSettings({ enabled: true, pauseWhenIdle: false, maxRestarts: 3 });
			h.supervisor.noteOrchestrator(REPO, dispatched(['19'])); // host re-feeds the SAME pass on enable
			assert.equal(h.spawner.requests.length, 1); // the pending plan now reconciles, exactly once
		});

		it('reconciles a dispatch fed with NO worker template once the template is approved and re-fed', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [agent()]); // planner only — worker entry not yet approved
			h.supervisor.noteOrchestrator(REPO, dispatched(['19']));
			assert.equal(h.spawner.requests.length, 0); // no template: logs the gap, spawns nothing, pass NOT marked reconciled
			h.supervisor.setAgents(REPO, [agent(), workerAgent()]); // worker entry approved later
			h.supervisor.noteOrchestrator(REPO, dispatched(['19'])); // host re-feeds the SAME pass
			assert.equal(h.spawner.requests.length, 1); // the pending plan now reconciles, exactly once
		});

		it('stops live workers on stopAll', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [workerAgent()]);
			h.supervisor.noteOrchestrator(REPO, dispatched(['19', '20']));
			h.supervisor.stopAll();
			assert.equal(h.spawner.kills, 2);
		});

		it('keeps worker templates out of the scheduled-agent states', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [agent(), workerAgent()]);
			assert.deepEqual(
				h.supervisor.states().map((s) => s.agentId),
				['orc'],
			);
		});

		it('workerStates reports live workers with repoRoot, dropping exited ones', () => {
			const h = makeSupervisor();
			h.supervisor.setAgents(REPO, [workerAgent()]);
			h.supervisor.noteOrchestrator(REPO, dispatched(['19', '20']));
			assert.deepEqual(
				h.supervisor.workerStates().map((w) => `${w.repoRoot}:${w.key}`),
				[`${REPO}:19`, `${REPO}:20`],
			);
			h.spawner.events[0].onExit(0); // worker 19 exits
			assert.deepEqual(
				h.supervisor.workerStates().map((w) => w.key),
				['20'],
			);
		});
	});

	describe('built-in routing', () => {
		it('runs a built-in entry through builtInSpawn and others through the process spawner', () => {
			const clock = new ManualClock();
			const proc = new FakeSpawner();
			const builtIn = new FakeSpawner();
			const supervisor = new AgentSupervisor(
				{
					spawn: proc.spawn,
					builtInSpawn: builtIn.spawn,
					now: () => clock.now,
					schedule: clock.schedule,
					log: () => undefined,
					onStateChange: () => undefined,
				},
				{ enabled: true, pauseWhenIdle: false, maxRestarts: 3 },
			);
			supervisor.setAgents(REPO, [
				agent({ id: 'tick', type: 'built-in', command: '', args: [] }),
				agent({ id: 'orc' }),
			]);
			supervisor.control(REPO, 'tick', 'start');
			supervisor.control(REPO, 'orc', 'start');
			assert.equal(builtIn.requests.length, 1, 'built-in tick must spawn through builtInSpawn');
			assert.equal(proc.requests.length, 1, 'the exec agent must spawn through the process spawner');
		});

		it('fails a built-in entry loudly when no in-process spawner is wired (no cryptic ENOENT)', () => {
			const h = makeSupervisor(); // harness provides no builtInSpawn
			h.supervisor.setAgents(REPO, [agent({ id: 'tick', type: 'built-in', command: '', args: [] })]);
			h.supervisor.control(REPO, 'tick', 'start');
			// The stand-in runs instead of the process spawner: the empty command
			// is never spawned, and the failure is a clear logged line.
			assert.equal(h.spawner.requests.length, 0, 'must not spawn the empty built-in command');
			assert.ok(
				h.logs.some((l) => l.includes('no in-process planner spawner')),
				h.logs.join('\n'),
			);
		});
	});
});
