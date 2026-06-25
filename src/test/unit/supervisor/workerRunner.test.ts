/**
 * Unit tests for supervisor/workerRunner.ts — the one-shot worker process:
 * spawn, liveness, wall-clock timeout, and reap-on-exit (no reschedule).
 */

import assert from 'node:assert/strict';

import { SpawnRequest } from '../../../supervisor/agentRunner';
import { WorkerRunner, WorkerRunnerDeps } from '../../../supervisor/workerRunner';
import { FakeSpawner } from '../helpers/fakeSpawner';
import { ManualClock } from '../helpers/manualClock';

const REQUEST: SpawnRequest = {
	command: 'claude',
	args: ['-p', '/status-pipe:work-ticket 19'],
	cwd: '/wt/19',
	env: {},
	stdin: '',
};

interface Harness {
	clock: ManualClock;
	spawner: FakeSpawner;
	runner: WorkerRunner;
	logs: string[];
	doneCount: number;
}

function makeRunner(timeoutMinutes = 45): Harness {
	const clock = new ManualClock();
	const spawner = new FakeSpawner();
	const logs: string[] = [];
	const h = { clock, spawner, logs, doneCount: 0 } as Harness;
	const deps: WorkerRunnerDeps = {
		spawn: spawner.spawn,
		now: () => clock.now,
		schedule: clock.schedule,
		log: (line) => logs.push(line),
		onDone: () => {
			h.doneCount += 1;
		},
	};
	h.runner = new WorkerRunner('19', REQUEST, timeoutMinutes, deps);
	return h;
}

describe('supervisor/workerRunner', () => {
	it('spawns the request on start and reports alive', () => {
		const h = makeRunner();
		h.runner.start();
		assert.equal(h.spawner.requests.length, 1);
		assert.deepEqual(h.spawner.requests[0].args, ['-p', '/status-pipe:work-ticket 19']);
		assert.equal(h.runner.alive, true);
	});

	it('tracks last output time', () => {
		const h = makeRunner();
		h.runner.start();
		h.clock.now = 5_000;
		h.spawner.outputLast('{"type":"assistant"}');
		assert.equal(h.runner.snapshot().lastOutputAt, 5_000);
	});

	it('snapshot carries the key, uptime, and parsed activity (no repoRoot)', () => {
		const h = makeRunner();
		h.clock.now = 1_000;
		h.runner.start();
		h.clock.now = 4_000;
		const snap = h.runner.snapshot();
		assert.equal(snap.key, '19');
		assert.equal(snap.runningSince, 1_000);
		assert.equal(snap.lastOutputAt, null);
		assert.ok('activity' in snap);
		assert.equal('repoRoot' in snap, false);
	});

	it('reaps once on exit: not alive, onDone fired', () => {
		const h = makeRunner();
		h.runner.start();
		h.spawner.exitLast(0);
		assert.equal(h.runner.alive, false);
		assert.equal(h.doneCount, 1);
		// A duplicate exit event is inert.
		h.spawner.events[0].onExit(0);
		assert.equal(h.doneCount, 1);
	});

	it('kills the process when it exceeds its timeout', async () => {
		const h = makeRunner(5);
		h.runner.start();
		await h.clock.advance(5 * 60_000);
		assert.equal(h.spawner.kills, 1);
	});

	it('treats a spawn failure as an immediate exit', () => {
		const h = makeRunner();
		h.spawner.failNext = new Error('ENOENT');
		h.runner.start();
		assert.equal(h.runner.alive, false);
		assert.equal(h.doneCount, 1);
	});

	it('cancels the timeout once exited (no late kill)', async () => {
		const h = makeRunner(5);
		h.runner.start();
		h.spawner.exitLast(0);
		await h.clock.advance(10 * 60_000);
		assert.equal(h.spawner.kills, 0);
	});

	it('cancels the timeout on stop() so it cannot fire a late second kill', async () => {
		const h = makeRunner(5);
		h.runner.start();
		h.runner.stop(); // one kill from stop…
		await h.clock.advance(10 * 60_000); // …and the armed timeout must not add another
		assert.equal(h.spawner.kills, 1);
	});
});
