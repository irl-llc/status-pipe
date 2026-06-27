/**
 * The planner's input contract and structured pass report. The report is the
 * deterministic, machine-readable equivalent of the prose the LLM tick used to
 * print — the supervisor logs it and the queue already renders the live state,
 * so it carries just what a pass *did*, not a human narrative.
 */

import { DispatchItem, DispatchPlan, ParkedState, TrustMode } from '../protocol/types';

/** Repo conventions + this-pass parameters the planner reconciles against. */
export interface PlannerConfig {
	epicsDir: string;
	inventoryLabel: string;
	/** Optional assignee routing filter (orthogonal to trust); empty = no scoping. */
	inventoryAssignees: string[];
	trustMode: TrustMode | null;
	trustOperators: string[];
	staleWorkerMinutes: number;
}

export interface PlannerInput {
	/** Repo identity (`owner/name`) stamped into freshly-minted ticket files. */
	repo: string;
	config: PlannerConfig;
	/** The dispatch ceiling for this pass. */
	maxConcurrent: number;
	/** Keys with a live worker right now (supervisor truth); never re-dispatched. */
	liveWorkerKeys: string[];
}

/** The resolved trust posture, or a refusal that aborts the pass (fail closed). */
export type TrustResolution = { ok: true; mode: TrustMode; operators: string[] } | { ok: false; reason: string };

/** What one pass did — every field is deterministic given the inputs. */
export interface PlanReport {
	/** Non-null when the trust gate refused: nothing else ran. */
	refusedReason: string | null;
	/** ackIds matched and consumed (operator input handed to the worker). */
	consumedAcks: string[];
	/** ackIds dropped because the ticket state advanced before pickup. */
	supersededAcks: string[];
	/** ackIds deleted because their ticket file was gone. */
	orphanedAcks: string[];
	/** Ticket keys whose stale worker was reconciled to `error`. */
	staleReconciled: string[];
	/** Ticket keys revived because their forge issue was re-opened (terminal → planning). */
	reopened: string[];
	/** Ticket keys closed because their forge issue closed (→ merged/abandoned). */
	closedByReconcile: string[];
	/** Worktree slugs reclaimed because they no longer back active work. */
	worktreesRemoved: string[];
	/** Epic slugs whose tracking ticket the planner created this pass. */
	createdTrackingTickets: string[];
	/** Items dispatched (stamped + worktree'd + added to the plan). */
	dispatched: DispatchItem[];
	/** Ticket keys that were dispatchable but deferred by the concurrency cap. */
	deferred: string[];
	parked: ParkedState | null;
}

export interface PlanResult {
	/** The plan for the supervisor to execute, or null when nothing was dispatched. */
	dispatch: DispatchPlan | null;
	report: PlanReport;
}
