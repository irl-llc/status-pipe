/**
 * Trust gating + inventory visibility filtering (protocol skill §6,
 * plugin/commands/tick.md Step 0–1). Pure: the visibility/identity facts are
 * read through the inventory port and passed in here as plain values.
 */

import { TrustMode } from '../protocol/types';
import { InventoryTicket } from './ports';
import { TrustResolution } from './types';

export interface TrustFacts {
	visibility: 'public' | 'private';
	viewerLogin: string | null;
	trustMode: TrustMode | null;
	trustOperators: string[];
}

/**
 * Resolve the trust posture, failing closed. A declared mode wins. Otherwise a
 * public (or visibility-unknown, treated-as-public) repo refuses; a private
 * repo defaults to single-maintainer with the authenticated operator.
 */
export function resolveTrust(facts: TrustFacts): TrustResolution {
	if (facts.trustMode) {
		return { ok: true, mode: facts.trustMode, operators: facts.trustOperators };
	}
	if (facts.visibility === 'public') {
		return {
			ok: false,
			reason:
				'public repo without a declared trust mode — declare trust.mode and trust.operators in .status-pipe/config.json',
		};
	}
	if (!facts.viewerLogin) {
		return { ok: false, reason: 'private repo without a declared trust mode and no resolvable operator identity' };
	}
	return { ok: true, mode: 'single-maintainer', operators: [facts.viewerLogin] };
}

/** True when a labeled ticket is visible to this agent under the resolved trust mode. */
export function passesTrust(ticket: InventoryTicket, mode: TrustMode, operators: string[]): boolean {
	if (mode === 'single-maintainer') return true;
	const ops = new Set(operators);
	const assigned = ticket.assignees.some((a) => ops.has(a));
	if (mode === 'multi-maintainer') return assigned;
	return assigned || (ticket.author !== null && ops.has(ticket.author));
}

/**
 * Assignee routing scope (orthogonal to trust): with a non-empty allow-list,
 * keep only tickets assigned to one of those identities. Empty = no scoping.
 */
export function passesAssigneeScope(ticket: InventoryTicket, scope: string[]): boolean {
	if (scope.length === 0) return true;
	const allow = new Set(scope);
	return ticket.assignees.some((a) => allow.has(a));
}
