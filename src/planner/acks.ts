/**
 * Ack-inbox consumption (plugin/commands/tick.md Step 2). For each ack: a
 * match appends a history note and hands the operator's note to the worker as
 * fresh input (and bumps the ticket to top dispatch priority); a non-match is
 * superseded; an ack with no ticket file is an orphan. History is appended
 * BEFORE the ack file is deleted (crash-safe ordering).
 */

import { ackMatchesTicket } from '../protocol/ackId';
import { TicketFile } from '../protocol/types';
import { PlannerPorts, StoredAck } from './ports';
import { PlanReport } from './types';

/** Tickets whose ack was consumed this pass, mapped to the operator's note. */
export type ConsumedAcks = Map<string, string | null>;

async function appendHistory(ports: PlannerPorts, ticket: TicketFile, note: string): Promise<void> {
	const entry = { at: ports.clock.iso(), phase: ticket.phase, note, runId: null };
	await ports.write.writeTicket(ticket.ticket, { ...ticket, history: [...ticket.history, entry] });
}

function consumeNote(ackId: string, note: string | null, matched: boolean): string {
	return matched
		? `owner ack ${ackId} consumed: ${note ?? 'ready-for-look'}`
		: `ack ${ackId} superseded (state advanced before pickup)`;
}

async function consumeOne(
	ports: PlannerPorts,
	stored: StoredAck,
	consumed: ConsumedAcks,
	report: PlanReport,
): Promise<void> {
	const { ack, path } = stored;
	const ticket = await ports.read.readTicket(ack.ticket);
	if (!ticket) {
		await ports.write.deleteAck(path);
		report.orphanedAcks.push(ack.ackId);
		return;
	}
	const matched = ackMatchesTicket(ack, ticket);
	await appendHistory(ports, ticket, consumeNote(ack.ackId, ack.note, matched));
	await ports.write.deleteAck(path);
	if (matched) consumed.set(ack.ticket, ack.note);
	(matched ? report.consumedAcks : report.supersededAcks).push(ack.ackId);
}

/** Consume the inbox in the port's deterministic order; returns the matched tickets. */
export async function consumeAcks(ports: PlannerPorts, report: PlanReport): Promise<ConsumedAcks> {
	const consumed: ConsumedAcks = new Map();
	for (const stored of await ports.read.listAcks()) {
		await consumeOne(ports, stored, consumed, report);
	}
	return consumed;
}
