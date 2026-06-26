/**
 * Worker liveness — one predicate shared by the card (queue/lane.ts) and the
 * planner's staleness reconcile (planner/schedule.ts), so both report the SAME
 * truth about a worker. Two predicates here mean split-brain: the card showing
 * "(stale)"/crashed while the planner declines to reconcile the same ticket.
 *
 * A `running` worker is stale once its last sign of life — heartbeatAt, else the
 * startedAt fallback — has aged past the threshold. A running worker with NO
 * timestamp at all has no evidence of life and is treated as crashed (this only
 * arises from a malformed/partial ticket; the planner stamps both fields). Clock
 * skew (a "future" beat) clamps to fresh, never a negative age.
 */

import { WorkerState } from './types';

export function isWorkerStale(worker: WorkerState | null, staleWorkerMinutes: number, now: number): boolean {
	if (!worker || worker.status !== 'running') return false;
	const beat = worker.heartbeatAt ?? worker.startedAt;
	if (!beat) return true; // running with no evidence of life
	const beatMs = Date.parse(beat);
	if (Number.isNaN(beatMs)) return true;
	return Math.max(0, now - beatMs) > staleWorkerMinutes * 60_000;
}
