/**
 * Ack chip state machine + staleness predicate (design/02-protocol.md,
 * lifecycle section). Pure functions over (ticket, known acks, orchestrator
 * pass info, now).
 */

import { ackMatchesTicket, ackTargetFor } from '../protocol/ackId';
import { LaunchFile, OrchestratorFile, PLANNER_ID, TicketFile } from '../protocol/types';
import { AckChipDisplay, AckChipState, AckControlDisplay } from './displayTypes';
import { KnownAck } from './queueInputs';

export interface AckContext {
	orchestrator: OrchestratorFile | null;
	launch: LaunchFile | null;
	staleWorkerMinutes: number;
	now: number;
}

/**
 * Stale = the file still exists although an orchestrator pass ran (started
 * after the ack was created, since inbox consumption happens at tick start)
 * and completed without consuming it — or, when no pass has run since
 * creation, the ack is older than 2 × the expected tick interval. Keyed on
 * pass activity, not worker heartbeats: a slow-but-healthy cadence must not
 * page the operator on every ack.
 */
export function isAckStale(known: KnownAck, ctx: AckContext): boolean {
	if (!known.onDisk) return false;
	const created = Date.parse(known.ack.createdAt);
	if (Number.isNaN(created)) return false;
	if (passCompletedSince(created, ctx.orchestrator)) return true;
	return ctx.now - created > 2 * expectedTickIntervalMs(ctx);
}

function passCompletedSince(createdMs: number, orchestrator: OrchestratorFile | null): boolean {
	const started = parseTime(orchestrator?.lastPassStartedAt);
	const finished = parseTime(orchestrator?.lastPassFinishedAt);
	return started !== null && finished !== null && started > createdMs && finished >= started;
}

function expectedTickIntervalMs(ctx: AckContext): number {
	const tickAgent = ctx.launch?.agents.find((a) => a.id === PLANNER_ID);
	const minutes = tickAgent ? tickAgent.intervalMinutes : ctx.staleWorkerMinutes;
	return minutes * 60_000;
}

function parseTime(iso: string | null | undefined): number | null {
	if (!iso) return null;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : ms;
}

function chipStateFor(known: KnownAck, ticket: TicketFile, ctx: AckContext): AckChipState {
	const historyNote = ticket.history.find((h) => h.note.includes(known.ack.ackId));
	if (historyNote) {
		return /supersed/i.test(historyNote.note) ? 'superseded' : 'picked-up';
	}
	if (known.onDisk) {
		if (!ackMatchesTicket(known.ack, ticket)) return 'moved-on';
		return isAckStale(known, ctx) ? 'stale' : 'pending';
	}
	return 'pickup-unconfirmed';
}

function toChip(known: KnownAck, state: AckChipState): AckChipDisplay {
	return { state, ackId: known.ack.ackId, createdAt: known.ack.createdAt, note: known.ack.note };
}

function newestFirst(a: KnownAck, b: KnownAck): number {
	return (parseTime(b.ack.createdAt) ?? 0) - (parseTime(a.ack.createdAt) ?? 0);
}

/**
 * The operator answered the ticket's CURRENT request and the loop is honoring
 * it: a `pending` ack awaiting pickup, or a `picked-up` ack whose target still
 * matches the live `waitingOn`/blockers (handed back — the agent will act next,
 * not the operator; issue #57). A `picked-up` ack whose request the agent has
 * already advanced past (`waitingOn` moved on, so the ack no longer matches) is
 * a freshly-raised question, NOT honored — it must keep alarming. `pending`
 * already implies a matching target, so it needs no extra match check.
 */
function honorsCurrentRequest(known: KnownAck, ticket: TicketFile, ctx: AckContext): boolean {
	const state = chipStateFor(known, ticket, ctx);
	if (state === 'pending') return true;
	return state === 'picked-up' && ackMatchesTicket(known.ack, ticket);
}

/**
 * Derives the card's ack control: the most recent relevant chip plus whether
 * the "Ready for another look" button applies right now. The button hides once
 * the current request carries an ack the loop is honoring (pending pickup, or
 * picked up — the agent's turn now) or a `stale` ack (re-acking won't help; the
 * loop is down) — re-acking in those states would only overwrite the operator's
 * note (#57). `moved-on`/`pickup-unconfirmed`/`superseded` leave it live so a
 * fresh, lost-signal, or advanced-state request can still be acked.
 *
 * The button/chip key on the NEWEST ack only (like `isAcked`), while the lane's
 * `hasAckedCurrentRequest` keys on `some` — intentionally: the lane reflects
 * whether ANY ack parks the card, the chip reflects the latest signal. They are
 * not meant to agree.
 */
export function deriveAckControl(ticket: TicketFile, acks: KnownAck[], ctx: AckContext): AckControlDisplay {
	const sorted = [...acks].sort(newestFirst);
	const chipSource = sorted[0] ?? null;
	const chip = chipSource ? toChip(chipSource, chipStateFor(chipSource, ticket, ctx)) : null;
	const suppressed = chipSource !== null && (honorsCurrentRequest(chipSource, ticket, ctx) || chip?.state === 'stale');
	const actionable = ackTargetFor(ticket) !== null && !suppressed;
	return { actionable, chip };
}

/**
 * The current request is acked and the loop is honoring it — suppresses the
 * ackable NEEDS-YOU classes (blocked/owner/review/merge) and moves the card to
 * WAITING. True for a fresh `pending` ack and for a `picked-up` ack still
 * matching the request (the operator did their part; it is the agent's turn —
 * #57). A `stale` ack does the opposite (escalates), and
 * pickup-unconfirmed/moved-on deliberately do NOT suppress: a lost signal or a
 * newly-raised question must not be silently starved. Uses `some` so an older
 * ack that still answers the current request keeps the card calm even when a
 * newer ack has moved on.
 */
export function hasAckedCurrentRequest(ticket: TicketFile, acks: KnownAck[], ctx: AckContext): boolean {
	return acks.some((k) => honorsCurrentRequest(k, ticket, ctx));
}

/** Any on-disk ack gone stale (pass ran without consuming it)? */
export function hasStaleAck(ticket: TicketFile, acks: KnownAck[], ctx: AckContext): boolean {
	return acks.some((k) => chipStateFor(k, ticket, ctx) === 'stale');
}

/**
 * The operator handed this card back and the loop is honoring it: a fresh
 * ack is pending pickup, or it was already picked up. Excludes stale /
 * superseded / pickup-unconfirmed — those still want the operator's eye, so
 * they must keep their alarm visuals (issue #10). Evaluates only the newest
 * ack, matching the chip deriveAckControl shows: an older picked-up ack must
 * not calm a card whose newest ack went stale/moved-on.
 */
export function isAcked(ticket: TicketFile, acks: KnownAck[], ctx: AckContext): boolean {
	const newest = [...acks].sort(newestFirst)[0];
	if (!newest) {
		return false;
	}
	const state = chipStateFor(newest, ticket, ctx);
	return state === 'pending' || state === 'picked-up';
}
