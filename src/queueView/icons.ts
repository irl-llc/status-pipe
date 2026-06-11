/**
 * The iconography map (design/05-ui.md) — one codicon per fact.
 */

import { AckChipState, AgentRunState } from '../queue/displayTypes';
import { WaitingKind } from '../protocol/types';

export const WAITING_ICON: Record<WaitingKind, string> = {
	owner: 'person',
	review: 'eye',
	comment: 'comment',
	build: 'beaker',
	merge: 'git-merge',
};

export const ACK_CHIP_ICON: Record<AckChipState, string> = {
	pending: 'mail',
	'picked-up': 'check',
	superseded: 'history',
	'pickup-unconfirmed': 'question',
	stale: 'warning',
	'moved-on': 'warning',
};

export const AGENT_STATE_ICON: Record<AgentRunState, string> = {
	disabled: 'circle-slash',
	stopped: 'debug-stop',
	scheduled: 'clock',
	launching: 'loading',
	running: 'pulse',
	backoff: 'history',
	failed: 'warning',
	parked: 'coffee',
};
