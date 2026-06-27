/**
 * The deterministic status-pipe planner: a pure, vscode-free reconciliation
 * pass that replaces the LLM `/status-pipe:tick`. The extension runs it
 * in-process; the standalone CLI will reuse the same module (see #39).
 */

export { plan } from './plan';
export { deriveLiveWorkerKeys } from './liveWorkers';
export {
	DEFAULT_MAX_CONCURRENT,
	buildPlannerPorts,
	formatPlanReport,
	plannerConfigFromFile,
	runPlannerPass,
} from './runPass';
export type { PlannerPassArgs } from './runPass';
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
	WorktreeInfo,
} from './ports';
export type { PlannerConfig, PlannerInput, PlanReport, PlanResult, TrustResolution } from './types';
