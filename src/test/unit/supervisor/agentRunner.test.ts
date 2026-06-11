/**
 * Unit tests for supervisor/agentRunner.ts — the per-(repo, agent) state
 * machine, driven by a fake Spawner and a manual clock/scheduler.
 */

import assert from 'node:assert/strict';

import { LaunchAgent, ParkedState } from '../../../protocol/types';
import { AgentRunState } from '../../../queue/displayTypes';
import { AgentRunner } from '../../../supervisor/agentRunner';
import { FakeSpawner } from '../helpers/fakeSpawner';
import { ManualClock } from '../helpers/manualClock';

function agent(overrides: Partial<LaunchAgent> = {}): LaunchAgent {
	return {
		id: 'orc',
		title: 'Orchestrator',
		command: 'claude',
		args: ['-p'],
		stdin: 'tick',
		cwd: '/work/repo',
		env: { KEY: 'v' },
		mode: 'tick',
		intervalMinutes: 10,
		timeoutMinutes: 5,
		...overrides,
	};
}

interface Harness {
	clock: ManualClock;
	spawner: FakeSpawner;
	runner: AgentRunner;
	stateLog: AgentRunState[];
	logs: string[];
	parked: { value: ParkedState | null };
	idle: { value: boolean };
}

function makeRunner(overrides: Partial<LaunchAgent> = {}, maxRestarts = 3): Harness {
	const clock = new ManualClock();
	const spawner = new FakeSpawner();
	const stateLog: AgentRunState[] = [];
	const logs: string[] = [];
	const parked = { value: null as ParkedState | null };
	const idle = { value: false };
	const runner: AgentRunner = new AgentRunner('/work/repo', agent(overrides), {
		spawn: spawner.spawn,
		now: () => clock.now,
		schedule: clock.schedule,
		log: (line) => logs.push(line),
		onStateChange: () => stateLog.push(runner.snapshot().state),
		isParked: () => parked.value,
		isIdlePaused: () => idle.value,
		maxRestarts: () => maxRestarts,
	});
	return { clock, spawner, runner, stateLog, logs, parked, idle };
}

const PARKED: ParkedState = { since: '2026-06-01T00:00:00Z', reason: 'all work waiting on you', recheckAfter: null };

describe('supervisor/agentRunner', () => {
	it('start passes through launching to a running snapshot', () => {
		const h = makeRunner();
		h.runner.start();
		assert.deepEqual(h.stateLog, ['launching', 'running']);
		const snap = h.runner.snapshot();
		assert.equal(snap.state, 'running');
		assert.equal(snap.runningSince, h.clock.now);
		assert.equal(h.spawner.requests.length, 1);
		assert.deepEqual(h.spawner.requests[0], {
			command: 'claude',
			args: ['-p'],
			cwd: '/work/repo',
			env: { KEY: 'v' },
			stdin: 'tick',
		});
	});

	it('clean tick exit reschedules at intervalMinutes from EXIT time', async () => {
		const h = makeRunner();
		h.runner.start();
		await h.clock.advance(120_000); // pass runs 2 minutes
		h.spawner.exitLast(0);
		const snap = h.runner.snapshot();
		assert.equal(snap.state, 'scheduled');
		assert.equal(snap.consecutiveFailures, 0);
		assert.equal(snap.nextTickAt, 120_000 + 10 * 60_000);

		await h.clock.advance(10 * 60_000);
		assert.equal(h.spawner.requests.length, 2);
		assert.equal(h.runner.snapshot().state, 'running');
	});

	it('failures back off 1m then 2m, then hit failed at maxRestarts with detail', async () => {
		const h = makeRunner();
		h.runner.start();
		h.spawner.exitLast(1);
		let snap = h.runner.snapshot();
		assert.equal(snap.state, 'backoff');
		assert.equal(snap.consecutiveFailures, 1);
		assert.equal(snap.detail, 'exit 1 ×1');
		assert.equal(snap.nextTickAt, h.clock.now + 60_000);

		await h.clock.advance(60_000);
		h.spawner.exitLast(1);
		snap = h.runner.snapshot();
		assert.equal(snap.state, 'backoff');
		assert.equal(snap.nextTickAt, h.clock.now + 120_000);

		await h.clock.advance(120_000);
		h.spawner.exitLast(1);
		snap = h.runner.snapshot();
		assert.equal(snap.state, 'failed');
		assert.equal(snap.detail, 'exit 1 ×3');
		assert.equal(snap.nextTickAt, null);

		// retry() resets the failure count and relaunches immediately.
		h.runner.retry();
		assert.equal(h.runner.snapshot().state, 'running');
		assert.equal(h.runner.snapshot().consecutiveFailures, 0);
	});

	it('kills a tick past timeoutMinutes and routes the exit as a failure', async () => {
		const h = makeRunner();
		h.runner.start();
		await h.clock.advance(5 * 60_000);
		assert.equal(h.spawner.kills, 1);
		h.spawner.exitLast(null); // the kill lands
		const snap = h.runner.snapshot();
		assert.equal(snap.state, 'backoff');
		assert.equal(snap.consecutiveFailures, 1);
		assert.equal(snap.detail, 'tick exceeded 5m — killed');
	});

	it('operator stop kills, reports stopped, and never reschedules on exit', async () => {
		const h = makeRunner();
		h.runner.start();
		h.runner.stop();
		assert.equal(h.spawner.kills, 1);
		assert.equal(h.runner.snapshot().state, 'stopped');
		assert.equal(h.runner.snapshot().detail, 'stopped by operator');

		h.spawner.exitLast(null);
		assert.equal(h.runner.snapshot().state, 'stopped');
		await h.clock.advance(60 * 60_000);
		assert.equal(h.spawner.requests.length, 1);
	});

	it('wake() while scheduled launches immediately', async () => {
		const h = makeRunner();
		h.runner.start();
		h.spawner.exitLast(0);
		assert.equal(h.runner.snapshot().state, 'scheduled');
		h.runner.wake();
		assert.equal(h.runner.snapshot().state, 'running');
		assert.equal(h.spawner.requests.length, 2);
		assert.equal(h.clock.pendingCount(), 1); // only the new timeout is armed
	});

	it('wake() while running marks pendingWake and relaunches right after a clean exit', () => {
		const h = makeRunner();
		h.runner.start();
		h.runner.wake();
		assert.equal(h.spawner.requests.length, 1);
		h.spawner.exitLast(0);
		// No interval wait: the follow-up tick fires immediately.
		assert.equal(h.spawner.requests.length, 2);
		assert.equal(h.runner.snapshot().state, 'running');
	});

	describe('daemon mode', () => {
		it('restarts ~1s after an exit with healthy (>60s) uptime, without failure', async () => {
			const h = makeRunner({ mode: 'daemon' });
			h.runner.start();
			await h.clock.advance(61_000);
			h.spawner.exitLast(1);
			const snap = h.runner.snapshot();
			assert.equal(snap.state, 'scheduled');
			assert.equal(snap.consecutiveFailures, 0);
			assert.equal(snap.nextTickAt, h.clock.now + 1_000);
			await h.clock.advance(1_000);
			assert.equal(h.spawner.requests.length, 2);
		});

		it('takes the backoff path when the daemon dies within a minute', async () => {
			const h = makeRunner({ mode: 'daemon' });
			h.runner.start();
			await h.clock.advance(30_000);
			h.spawner.exitLast(1);
			const snap = h.runner.snapshot();
			assert.equal(snap.state, 'backoff');
			assert.equal(snap.consecutiveFailures, 1);
		});

		it('checkDaemonWedged kills when progress is older than 2× the interval', async () => {
			const h = makeRunner({ mode: 'daemon', intervalMinutes: 10 });
			h.runner.start();
			await h.clock.advance(2 * 10 * 60_000 + 1);
			h.runner.checkDaemonWedged(null);
			assert.equal(h.spawner.kills, 1);
			h.spawner.exitLast(null);
			assert.match(h.runner.snapshot().detail ?? '', /wedged/);

			// A recent lastPassFinishedAt keeps a long-running daemon alive.
			const fresh = makeRunner({ mode: 'daemon', intervalMinutes: 10 });
			fresh.runner.start();
			await fresh.clock.advance(2 * 10 * 60_000 + 1);
			fresh.runner.checkDaemonWedged(fresh.clock.now - 1_000);
			assert.equal(fresh.spawner.kills, 0);
		});
	});

	describe('parking', () => {
		it('shows parked while scheduled and isParked() returns a state', () => {
			const h = makeRunner();
			h.runner.start();
			h.spawner.exitLast(0);
			h.parked.value = PARKED;
			assert.equal(h.runner.snapshot().state, 'parked');
			h.parked.value = null;
			assert.equal(h.runner.snapshot().state, 'scheduled');
		});

		it('skips the launch when the timer fires while parked and rechecks in 1m', async () => {
			const h = makeRunner();
			h.runner.start();
			h.spawner.exitLast(0);
			h.parked.value = PARKED;
			await h.clock.advance(10 * 60_000);
			assert.equal(h.spawner.requests.length, 1);
			const snap = h.runner.snapshot();
			assert.equal(snap.state, 'parked');
			assert.equal(snap.detail, 'all work waiting on you');
			assert.equal(snap.nextTickAt, h.clock.now + 60_000);

			h.parked.value = null;
			await h.clock.advance(60_000);
			assert.equal(h.spawner.requests.length, 2);
		});

		it('treats idle pause exactly like parking, with its own detail', async () => {
			const h = makeRunner();
			h.runner.start();
			h.spawner.exitLast(0);
			h.idle.value = true;
			await h.clock.advance(10 * 60_000);
			assert.equal(h.spawner.requests.length, 1);
			assert.equal(h.runner.snapshot().detail, 'paused (window idle)');
			assert.equal(h.runner.snapshot().nextTickAt, h.clock.now + 60_000);
		});
	});

	it('records spawn failures as exit 127', () => {
		const h = makeRunner();
		h.spawner.failNext = new Error('ENOENT');
		h.runner.start();
		const snap = h.runner.snapshot();
		assert.equal(snap.lastExitCode, 127);
		assert.equal(snap.state, 'backoff');
		assert.ok(h.logs.some((l) => l.includes('spawn failed: ENOENT')));
	});
});
