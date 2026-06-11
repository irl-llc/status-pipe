/**
 * The iconography map (design/05-ui.md) — one codicon per fact.
 */

import { AckChipState, AgentRunState, NeedsYouReason } from '../queue/displayTypes';
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

export function reasonIcon(reason: NeedsYouReason): string {
	switch (reason) {
		case 'launcher-failed':
		case 'worker-crashed':
		case 'stale-ack':
		case 'degraded':
			return 'warning';
		case 'blocked':
			return 'circle-slash';
		case 'owner':
			return 'person';
		case 'review':
			return 'eye';
		case 'merge':
			return 'git-merge';
		case 'orphaned-ci':
			return 'x';
	}
}
