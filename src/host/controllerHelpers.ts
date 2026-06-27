/**
 * Helpers split out of controller.ts to keep it within its size budget: ticket-shaping,
 * timers, and the self-contained settled-ticket removal (which owns its own I/O).
 */

import * as vscode from 'vscode';

import { RepoContext } from '../discovery/repoScan';
import { deleteTicketFile } from '../protocol/ticketRemover';
import { TicketFile } from '../protocol/types';
import { isQuiet } from '../queue/lane';
import { RepoProtocolState, loadRepoProtocol } from './protocolStore';

/** The successfully-parsed ticket files from a repo's protocol state. */
export function goodTickets(state: RepoProtocolState): TicketFile[] {
	return state.tickets.flatMap((t) => (t.parsed.ok ? [t.parsed.value] : []));
}

/**
 * The operator's settled-ticket removal, end to end and rejection-free. Re-reads fresh
 * (closing the revive race the debounced cache leaves open), QUIET-gates, then unlinks
 * inside tickets/. EVERY failure — a load error, an unknown/active ticket, an unsafe key,
 * a failed unlink — returns a status, never throws, so the host can't hit an unhandled
 * rejection. The controller just maps 'removed' → reload.
 */
export async function removeSettledTicket(
	context: RepoContext,
	ticketKey: string,
): Promise<'removed' | 'not-allowed' | 'error'> {
	let state: RepoProtocolState;
	try {
		state = await loadRepoProtocol(context);
	} catch {
		return 'error';
	}
	const ticket = goodTickets(state).find((t) => t.ticket === ticketKey);
	if (!ticket) return 'error';
	if (!isQuiet(ticket)) return 'not-allowed';
	try {
		await deleteTicketFile(context.protocolDir, ticketKey);
		return 'removed';
	} catch {
		return 'error';
	}
}

/** setTimeout that returns its own canceller. */
export function scheduleTimer(fn: () => void, ms: number): () => void {
	const timer = setTimeout(fn, ms);
	return () => clearTimeout(timer);
}

/** The extension's semver, for ack attribution (`createdBy`). */
export function extensionVersion(ctx: vscode.ExtensionContext): string {
	const packageJson = ctx.extension.packageJSON as { version?: string };
	return packageJson.version ?? '0.0.0';
}
