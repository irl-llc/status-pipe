/**
 * Adapter: a forge's issue inventory (src/forge) → the planner's InventoryPort.
 * The two surfaces are deliberately separate vocabularies — the forge layer
 * knows "issues", the planner knows "tickets" — and this thin map is the only
 * seam between them, so the pure planner core (plan.ts) never imports forge.
 * Both the extension and the standalone CLI build their InventoryPort here.
 */

import { ForgeInventory, InventoryIssue, IssueState } from '../forge/types';
import { InventoryPort, InventoryTicket, TicketState } from './ports';

export function forgeInventoryPort(inventory: ForgeInventory): InventoryPort {
	return {
		visibility: () => inventory.visibility(),
		viewerLogin: () => inventory.viewerLogin(),
		listLabeledTickets: async (label) => (await inventory.listLabeledIssues(label)).map(asTicket),
		getTicketStates: async (keys) => mapTicketStates(await inventory.getIssueStates(keys)),
		findTrackingTicket: async (title) => {
			const issue = await inventory.findIssueByTitle(title);
			return issue ? asTicket(issue) : null;
		},
		createTrackingTicket: async (title, label) => asTicket(await inventory.createLabeledIssue(title, label)),
	};
}

function asTicket(issue: InventoryIssue): InventoryTicket {
	return {
		key: issue.key,
		title: issue.title,
		url: issue.url,
		author: issue.author,
		assignees: issue.assignees,
	};
}

/** Rename the forge state map into the planner vocab (decouples plan.ts from forge types). */
function mapTicketStates(states: Map<string, IssueState>): Map<string, TicketState> {
	return new Map([...states].map(([key, s]) => [key, { state: s.state, stateReason: s.stateReason }]));
}
