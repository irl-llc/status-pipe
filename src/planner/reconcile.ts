/**
 * Lifecycle reconcile (the "suspenders" half of the close/GC/re-open design):
 * the forge issue's open/closed state is the source of truth; the ticket file's
 * terminal `phase` is a cache of it, reconciled here every pass.
 *
 * - reconcileReopened: a candidate (open + labeled) whose file is terminal AND
 *   whose forge issue reports `reopened` ⇒ the operator re-opened it ⇒ clear
 *   terminal so it dispatches again THIS pass. The forge check (not merely
 *   "terminal + still labeled") is what stops a merged ticket whose PR never
 *   auto-closed its issue from being revived and re-closed every pass.
 * - reconcileClosed: a non-terminal file that has dropped OUT of the candidate
 *   set, confirmed closed via a forge lookup ⇒ write the terminal state. A lookup
 *   failure closes nothing (a forge hiccup must never abandon a live ticket).
 * - garbageCollectWorktrees: drop every worktree that backs no active work — the
 *   planner-side guarantee behind the worker's opportunistic self-remove.
 *
 * The ticket file is never deleted here (that is the operator's call); only its
 * `phase`/`health` flip, so a re-opened worker resumes from preserved memory.
 */

import { Phase, TicketFile } from '../protocol/types';
import { Candidate } from './inventory';
import { TicketState } from './ports';
import { isTerminal, PassState } from './schedule';

/** A terminal candidate whose forge issue reports `reopened` — revive it. */
export async function reconcileReopened(state: PassState, candidates: Candidate[]): Promise<void> {
	const terminal = candidates.filter((c) => isTerminal(state.tickets.get(c.key)));
	if (terminal.length === 0) return;
	const states = await safeGetStates(
		state,
		terminal.map((c) => c.key),
	);
	const iso = state.ports.clock.iso();
	for (const c of terminal) {
		const ticket = state.tickets.get(c.key);
		if (!ticket || states.get(c.key)?.stateReason !== 'reopened') continue;
		const updated = asReopened(ticket, iso);
		state.tickets.set(c.key, updated);
		await state.ports.write.writeTicket(c.key, updated);
		state.report.reopened.push(c.key);
	}
}

function asReopened(ticket: TicketFile, iso: string): TicketFile {
	const note = `forge issue live again (was ${ticket.phase}); reopened by reconcile`;
	return {
		...ticket,
		phase: 'planning',
		health: 'ok',
		history: [...ticket.history, { at: iso, phase: ticket.phase, note, runId: null }],
		updatedAt: iso,
	};
}

/** A non-terminal file that left the open queue and is confirmed closed — close it. */
export async function reconcileClosed(state: PassState, candidates: Candidate[]): Promise<void> {
	const drift = driftKeys(state, candidates);
	if (drift.length === 0) return;
	const states = await safeGetStates(state, drift);
	const iso = state.ports.clock.iso();
	for (const key of drift) {
		const verdict = states.get(key);
		const ticket = state.tickets.get(key);
		if (!ticket || verdict?.state !== 'closed') continue;
		const updated = asClosed(ticket, verdict, iso);
		state.tickets.set(key, updated);
		await state.ports.write.writeTicket(key, updated);
		state.report.closedByReconcile.push(key);
	}
}

/** Loaded ticket files that are NOT a candidate this pass and not already terminal. */
function driftKeys(state: PassState, candidates: Candidate[]): string[] {
	const candidateKeys = new Set(candidates.map((c) => c.key));
	return [...state.tickets.keys()].filter((k) => !candidateKeys.has(k) && !isTerminal(state.tickets.get(k)));
}

/** A forge hiccup must never close a live ticket: a failed lookup yields no verdicts. */
async function safeGetStates(state: PassState, keys: string[]): Promise<Map<string, TicketState>> {
	try {
		return await state.ports.inventory.getTicketStates(keys);
	} catch {
		return new Map();
	}
}

function asClosed(ticket: TicketFile, verdict: TicketState, iso: string): TicketFile {
	const phase: Phase = verdict.stateReason === 'not_planned' ? 'abandoned' : 'merged';
	const note = `forge issue closed (${verdict.stateReason ?? 'unspecified'}); ${phase} by reconcile`;
	return {
		...ticket,
		phase,
		health: 'done',
		history: [...ticket.history, { at: iso, phase: ticket.phase, note, runId: null }],
		updatedAt: iso,
	};
}

/** Remove every managed worktree that no longer backs active work. Idempotent. */
export async function garbageCollectWorktrees(state: PassState, candidates: Candidate[]): Promise<void> {
	const active = activeSlugs(state, candidates);
	for (const wt of await state.ports.git.listWorktrees()) {
		if (active.has(wt.slug)) continue;
		// One slug's git failure must not strand the rest of the sweep (or the pass).
		try {
			await state.ports.git.removeWorktree(wt.slug);
			state.report.worktreesRemoved.push(wt.slug);
		} catch {
			/* leave it for the next pass */
		}
	}
}

/** Slugs that back live work: every non-terminal candidate, plus every non-terminal ticket file. */
function activeSlugs(state: PassState, candidates: Candidate[]): Set<string> {
	const slugs = new Set<string>();
	// A candidate whose ticket is terminal (e.g. issue still open+labeled, but the work
	// is merged/abandoned) backs no live work — keeping its slug would strand the worktree.
	for (const c of candidates) {
		if (!isTerminal(state.tickets.get(c.key))) slugs.add(c.slug);
	}
	// `ticket.slug` is the authoritative dispatch slug (persisted by schedule.ts at
	// dispatch); the `ticket-<key>` fallback only covers a legacy file written before
	// that, and is correct for a plain ticket but NOT an epic — so persistence matters.
	for (const [key, ticket] of state.tickets) {
		if (!isTerminal(ticket)) slugs.add(ticket.slug ?? `ticket-${key}`);
	}
	return slugs;
}
