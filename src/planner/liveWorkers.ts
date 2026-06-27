/**
 * Live-worker derivation for a planner that runs WITHOUT a process supervisor
 * (the standalone CLI, #39). The in-process extension knows which workers are
 * alive from its own process table and passes that set as `liveWorkerKeys`. A
 * standalone planner has no such table: the only liveness signal is the ticket
 * file's own heartbeat. So "live" = a ticket whose worker is `running` and whose
 * heartbeat has NOT aged past `staleWorkerMinutes` — exactly the predicate the
 * card and the staleness reconcile already share (`isWorkerStale`).
 *
 * Passing `[]` instead would be a correctness bug: the staleness reconcile would
 * flip every running worker to `error` (racing its writes) and dispatch would
 * re-spawn a key whose worker is alive and heartbeating. The heartbeat IS the
 * contract here, and `staleWorkerMinutes` is its tolerance.
 */

import { isWorkerStale } from '../protocol/worker';
import { ProtocolReadPort } from './ports';

export async function deriveLiveWorkerKeys(
	read: ProtocolReadPort,
	staleWorkerMinutes: number,
	now: number,
): Promise<string[]> {
	const keys = await read.listTicketKeys();
	const tickets = await Promise.all(keys.map((key) => read.readTicket(key)));
	const live: string[] = [];
	for (let i = 0; i < keys.length; i++) {
		const worker = tickets[i]?.worker ?? null;
		if (worker?.status === 'running' && !isWorkerStale(worker, staleWorkerMinutes, now)) {
			live.push(keys[i]);
		}
	}
	return live;
}
