/**
 * Lane assignment + priority ranking (design/05-ui.md "Queue semantics").
 *
 * The underlying NEEDS-YOU predicate is "agent parked, AND parked on me".
 * Priority is (class rank, age) — explainable at a glance; a blended
 * staleness score was deliberately rejected as unauditable.
 */

import { TicketFile } from '../protocol/types';
import { isWorkerStale } from '../protocol/worker';
import { Lane, NeedsYouReason, PrRowDisplay } from './displayTypes';
import { RepoEnrichment } from './queueInputs';

// Re-export the shared worker-liveness predicate so existing queue consumers
// (queueModel) keep importing it from here; the canonical definition — shared
// with the planner's reconcile — lives in src/protocol/worker.ts.
export { isWorkerStale };

/** Rank within NEEDS YOU; lower sorts first. Launcher cards are rank 0. */
export const REASON_RANK: Record<NeedsYouReason, number> = {
	'launcher-failed': 0,
	'worker-crashed': 1,
	'stale-ack': 2,
	blocked: 3,
	owner: 4,
	review: 5,
	merge: 6,
	'orphaned-ci': 7,
	degraded: 8,
};

export interface LaneContext {
	staleWorkerMinutes: number;
	now: number;
	enrichment: RepoEnrichment | null;
	/** An honored ack (pending, or picked-up still matching) suppresses the ackable classes (→ WAITING). */
	requestAcked: boolean;
	staleAck: boolean;
	/** Effective (enrichment-merged) PR rows for the orphaned-CI rule. */
	prRows: PrRowDisplay[];
}

export interface LaneAssignment {
	lane: Lane;
	reason: NeedsYouReason | null;
}

/** A settled ticket: terminal phase or `health: "done"` — the QUIET lane, and the
 *  only state in which an operator may remove the ticket file. */
export function isQuiet(ticket: TicketFile): boolean {
	return ticket.phase === 'merged' || ticket.phase === 'abandoned' || ticket.health === 'done';
}

function workerCrashed(ticket: TicketFile, ctx: LaneContext): boolean {
	return ticket.worker?.status === 'error' || isWorkerStale(ticket.worker, ctx.staleWorkerMinutes, ctx.now);
}

/**
 * Review demotion: when the forge attributes the requested reviewers and
 * none of them is the local user, the review isn't ours → WAITING. If
 * unattributable, include — false positives beat silent starvation.
 */
function reviewIsSomeoneElses(ticket: TicketFile, ctx: LaneContext): boolean {
	const viewer = ctx.enrichment?.viewerLogin;
	const prNumber = ticket.waitingOn?.pr;
	if (!viewer || typeof prNumber !== 'number') return false;
	const requests = ctx.enrichment?.prs[prNumber]?.info?.reviewRequests;
	if (!requests || requests.length === 0) return false;
	return !requests.includes(viewer);
}

function orphanedFailingCi(ticket: TicketFile, ctx: LaneContext): boolean {
	const workerIdle = !ticket.worker || ticket.worker.status === 'idle';
	if (!workerIdle || ticket.phase === 'fixing') return false;
	return ctx.prRows.some((pr) => pr.state === 'open' && pr.ci === 'failing');
}

function ackableReason(ticket: TicketFile, ctx: LaneContext): NeedsYouReason | null {
	if (ticket.health === 'blocked' || ticket.blockers.length > 0) return 'blocked';
	const kind = ticket.waitingOn?.kind;
	// 'comment': a reply is awaited and the operator is the default
	// responder. Demoting when the awaited reply is attributably someone
	// else's needs attribution data the forge layer doesn't fetch — so,
	// per the review rule's fallback, unattributable ⇒ include.
	if (kind === 'owner' || kind === 'comment') return 'owner';
	if (kind === 'review') return reviewIsSomeoneElses(ticket, ctx) ? null : 'review';
	if (kind === 'merge') return 'merge';
	return null;
}

function needsYouReason(ticket: TicketFile, ctx: LaneContext): NeedsYouReason | null {
	if (workerCrashed(ticket, ctx)) return 'worker-crashed';
	if (ctx.staleAck) return 'stale-ack';
	if (!ctx.requestAcked) {
		const reason = ackableReason(ticket, ctx);
		if (reason) return reason;
	}
	if (orphanedFailingCi(ticket, ctx)) return 'orphaned-ci';
	return null;
}

export function assignLane(ticket: TicketFile, ctx: LaneContext): LaneAssignment {
	if (isQuiet(ticket)) return { lane: 'quiet', reason: null };
	const reason = needsYouReason(ticket, ctx);
	if (reason) return { lane: 'needs-you', reason };
	return { lane: 'waiting', reason: null };
}
