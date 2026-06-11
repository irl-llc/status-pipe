/**
 * Ack chip state machine + staleness predicate (design/02-protocol.md,
 * lifecycle section). Pure functions over (ticket, known acks, orchestrator
 * pass info, now).
 */

import { ackMatchesTicket, ackTargetFor } from '../protocol/ackId';
import { LaunchFile, OrchestratorFile, TicketFile } from '../protocol/types';
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
	const tickAgent = ctx.launch?.agents.find((a) => a.mode === 'tick');
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
 * Derives the card's ack control: the most recent relevant chip plus
 * whether the "Ready for another look" button applies right now.
 */
export function deriveAckControl(ticket: TicketFile, acks: KnownAck[], ctx: AckContext): AckControlDisplay {
	const sorted = [...acks].sort(newestFirst);
	const chipSource = sorted[0] ?? null;
	const chip = chipSource ? toChip(chipSource, chipStateFor(chipSource, ticket, ctx)) : null;
	const hasLiveAck = chip !== null && (chip.state === 'pending' || chip.state === 'stale');
	const actionable = ackTargetFor(ticket) !== null && !hasLiveAck;
	return { actionable, chip };
}

/**
 * A fresh pending ack means "operator answered, waiting for pickup" — it
 * suppresses the ackable NEEDS-YOU classes (blocked/owner/review/merge) and
 * moves the card to WAITING. A stale ack does the opposite (escalates), and
 * pickup-unconfirmed deliberately does NOT suppress: if the consumption was
 * lost, suppressing would silently starve the item.
 */
export function hasFreshPendingAck(ticket: TicketFile, acks: KnownAck[], ctx: AckContext): boolean {
	return acks.some((k) => chipStateFor(k, ticket, ctx) === 'pending');
}

/** Any on-disk ack gone stale (pass ran without consuming it)? */
export function hasStaleAck(ticket: TicketFile, acks: KnownAck[], ctx: AckContext): boolean {
	return acks.some((k) => chipStateFor(k, ticket, ctx) === 'stale');
}
