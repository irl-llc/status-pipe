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
	/** A fresh pending ack suppresses the ackable classes (→ WAITING). */
	freshAckPending: boolean;
	staleAck: boolean;
	/** Effective (enrichment-merged) PR rows for the orphaned-CI and merge-gate rules. */
	prRows: PrRowDisplay[];
	/** config.reviewGate.requireCiGreen — gates the Layer-2 merge-ready CI backstop. */
	requireCiGreen: boolean;
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

/**
 * Layer-2 CI backstop (design/07, issue #36): a card the worker marked
 * merge-ready presents as 'merge' only when its PR's effective (live) CI is
 * actually passing. With `requireCiGreen`, a merge PR whose CI is not 'passing'
 * withholds the 'merge' reason — a failing PR then falls to 'orphaned-ci',
 * anything else (pending/none/unknown) to WAITING — so a worker that jumped the
 * gate is visibly corrected regardless of what it wrote. `requireCiGreen: false`
 * (a no-CI repo) disables the backstop. No live row to judge ⇒ trust the worker.
 */
function mergeReady(ticket: TicketFile, ctx: LaneContext): boolean {
	if (!ctx.requireCiGreen) return true;
	const prNumber = ticket.waitingOn?.pr;
	const open = ctx.prRows.filter((pr) => pr.state === 'open');
	const rows = typeof prNumber === 'number' ? open.filter((pr) => pr.number === prNumber) : open;
	return rows.length === 0 || rows.every((pr) => pr.ci === 'passing');
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
	if (kind === 'merge') return mergeReady(ticket, ctx) ? 'merge' : null;
	return null;
}

function needsYouReason(ticket: TicketFile, ctx: LaneContext): NeedsYouReason | null {
	if (workerCrashed(ticket, ctx)) return 'worker-crashed';
	if (ctx.staleAck) return 'stale-ack';
	if (!ctx.freshAckPending) {
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
