/**
 * The deterministic status-pipe planner: a pure, vscode-free reconciliation
 * pass that replaces the LLM `/status-pipe:tick`. The extension runs it
 * in-process; the standalone CLI will reuse the same module (see #39).
 */

export { plan } from './plan';
export type {
	Clock,
	EpicSpec,
	EpicsPort,
	GitPort,
	InventoryPort,
	InventoryTicket,
	PlannerPorts,
	ProtocolReadPort,
	ProtocolWritePort,
	StoredAck,
	TicketState,
} from './ports';
export type { PlannerConfig, PlannerInput, PlanReport, PlanResult, TrustResolution } from './types';
