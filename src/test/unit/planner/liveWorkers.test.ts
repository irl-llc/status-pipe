/**
 * deriveLiveWorkerKeys (src/planner/liveWorkers.ts) — the standalone planner's
 * liveness signal. "Live" must mean exactly `running` + a fresh heartbeat, the
 * same predicate the card and the staleness reconcile share. Anything looser
 * would re-dispatch a working ticket or reconcile a live one as crashed.
 */

import * as assert from 'assert';

import { deriveLiveWorkerKeys } from '../../../planner/liveWorkers';
import { ProtocolReadPort } from '../../../planner/ports';
import { TicketFile, WorkerState } from '../../../protocol/types';

const NOW = Date.parse('2026-06-27T12:00:00Z');
const STALE_MINUTES = 30;

function minutesAgo(n: number): string {
	return new Date(NOW - n * 60_000).toISOString();
}

function ticket(worker: WorkerState | null): TicketFile {
	return {
		schemaVersion: 1,
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
		worker,
		repo: 'acme/app',
		ticket: 'x',
		title: 'x',
		url: null,
		updatedAt: minutesAgo(0),
	};
}

function readPort(tickets: Record<string, TicketFile>): ProtocolReadPort {
	return {
		listTicketKeys: async () => Object.keys(tickets),
		readTicket: async (key) => tickets[key] ?? null,
		readOrchestrator: async () => null,
		listAcks: async () => [],
	};
}

describe('planner/deriveLiveWorkerKeys', () => {
	it('counts only running workers whose heartbeat is fresh', async () => {
		const port = readPort({
			fresh: ticket({ status: 'running', taskId: null, startedAt: minutesAgo(60), heartbeatAt: minutesAgo(5) }),
			stale: ticket({ status: 'running', taskId: null, startedAt: minutesAgo(60), heartbeatAt: minutesAgo(40) }),
			noBeatFresh: ticket({ status: 'running', taskId: null, startedAt: minutesAgo(5), heartbeatAt: null }),
			idle: ticket({ status: 'idle', taskId: null, startedAt: minutesAgo(5), heartbeatAt: minutesAgo(1) }),
			errored: ticket({ status: 'error', taskId: null, startedAt: minutesAgo(5), heartbeatAt: minutesAgo(1) }),
			noWorker: ticket(null),
		});
		const live = await deriveLiveWorkerKeys(port, STALE_MINUTES, NOW);
		assert.deepEqual(live.sort(), ['fresh', 'noBeatFresh']);
	});

	it('returns nothing for an empty protocol dir', async () => {
		assert.deepEqual(await deriveLiveWorkerKeys(readPort({}), STALE_MINUTES, NOW), []);
	});
});
