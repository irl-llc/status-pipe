/**
 * Ack identity + payload derivation (pure; design/02-protocol.md).
 *
 * ackId = first 8 hex chars of sha256(ticket + waitingKind + waitingSince),
 * plain UTF-8 concatenation. Always exactly 8 chars everywhere — history
 * notes and the chip state machine match the verbatim id, so truncation or
 * extension is a protocol violation. The hash makes the ack naturally
 * idempotent: re-acking the same outstanding request computes the same id.
 */

import { createHash } from 'crypto';

import { AckFile, AckTarget, TicketFile } from './types';

export function deriveAckId(ticket: string, waitingKind: string, waitingSince: string): string {
	return createHash('sha256').update(`${ticket}${waitingKind}${waitingSince}`, 'utf8').digest('hex').slice(0, 8);
}

/**
 * The target an ack for this ticket would carry right now, or null when the
 * ticket has nothing the operator can ack (no waitingOn, no blockers).
 *
 * Blockers-only tickets (blockers[] non-empty, waitingOn null) use the
 * synthetic waitingKind 'blockers' with waitingSince = the ticket file's
 * updatedAt — superseded as soon as the file changes.
 */
export function ackTargetFor(ticket: TicketFile): AckTarget | null {
	if (ticket.waitingOn) {
		const w = ticket.waitingOn;
		return { waitingKind: w.kind, waitingSince: w.since, ref: w.ref, pr: w.pr };
	}
	if (ticket.blockers.length > 0) {
		return { waitingKind: 'blockers', waitingSince: ticket.updatedAt, ref: null, pr: null };
	}
	return null;
}

export interface BuildAckOptions {
	ticket: TicketFile;
	note: string | null;
	createdAt: string;
	createdBy: string;
}

/** Builds the complete ack payload, or null when the ticket isn't ackable. */
export function buildAck(options: BuildAckOptions): AckFile | null {
	const target = ackTargetFor(options.ticket);
	if (!target) return null;
	return {
		schemaVersion: 1,
		kind: 'ready-for-look',
		ticket: options.ticket.ticket,
		ackId: deriveAckId(options.ticket.ticket, target.waitingKind, target.waitingSince),
		target,
		stateUpdatedAt: options.ticket.updatedAt,
		note: options.note,
		createdAt: options.createdAt,
		createdBy: options.createdBy,
	};
}

/**
 * True when an existing ack still answers the ticket's current request —
 * the supersession predicate from design/02-protocol.md.
 */
export function ackMatchesTicket(ack: AckFile, ticket: TicketFile): boolean {
	const current = ackTargetFor(ticket);
	if (!current) return false;
	return current.waitingKind === ack.target.waitingKind && current.waitingSince === ack.target.waitingSince;
}
