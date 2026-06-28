/**
 * Indicator meanings (design/05-ui.md rule 6: "Meaning is never JSON-only").
 * Every encoded indicator — an accent color, a status codicon, a staleness
 * tint — carries a tooltip naming the fact in words. These pure helpers map a
 * card's display state to that one-hover phrase; the components render them as
 * DOM tooltips (`data-tip` + `aria-label`, the `.tip` widget), not native
 * `title`. Keep them short and operator-readable.
 */

import { AgentRunState, CardDisplay } from '../queue/displayTypes';
import { Health, WaitingKind } from '../protocol/types';
import { formatDuration } from './format';

const HEALTH_MEANING: Record<Health, string> = {
	blocked: 'Blocked — needs you',
	error: 'Error — needs you',
	waiting: 'Waiting on you or the world',
	ok: 'Healthy — agent working',
	done: 'Done',
};

const WAITING_MEANING: Record<WaitingKind, string> = {
	owner: 'Waiting on you — a reply is needed',
	review: 'Waiting on review',
	comment: 'Waiting on a comment reply',
	build: 'Waiting on CI',
	merge: 'Ready to merge — your call',
};

/**
 * The accent bar's meaning. A stale worker (or stale ack) paints it error red
 * regardless of `health`, so its tooltip must name that override, not the
 * underlying health.
 */
export function accentMeaning(card: CardDisplay): string {
	if (card.worker?.stale) {
		const age = card.worker.heartbeatAgeMs;
		const when = age !== null ? `no heartbeat in ${formatDuration(age)}` : 'no heartbeat';
		return `Stale worker — ${when}`;
	}
	if (card.reason === 'stale-ack') return 'Stale ack — not picked up';
	return HEALTH_MEANING[card.health];
}

/**
 * The header status glyph's meaning (warning for crashed/degraded, pass-filled
 * for done). Returns `undefined` when there is no glyph so React omits the
 * `title` attribute entirely rather than rendering `title=""`.
 */
export function statusIconMeaning(card: CardDisplay): string | undefined {
	if (card.health === 'done') return 'Done';
	if (card.degraded) return `Degraded — ${card.degraded.detail}`;
	if (card.reason === 'worker-crashed') return 'Worker crashed — restart it';
	if (card.reason === 'launcher-failed') return 'Launcher failed — needs you';
	return undefined;
}

/** The waiting-line glyph's meaning (the kind in words, not the link behind it). */
export function waitingMeaning(kind: WaitingKind): string {
	return WAITING_MEANING[kind];
}

const AGENT_STATE_MEANING: Record<AgentRunState, string> = {
	disabled: 'Disabled',
	stopped: 'Stopped',
	scheduled: 'Scheduled — waiting for next tick',
	launching: 'Launching',
	running: 'Running',
	backoff: 'Backing off after a failure',
	failed: 'Failed — needs you',
	parked: 'Parked — all work waiting on you',
};

/**
 * The launch-config glyph's meaning. The live `detail` (failure cause, parked
 * reason) is richer when present; otherwise name the run state in words rather
 * than leaking the raw enum.
 */
export function agentStateMeaning(state: AgentRunState, detail: string | null): string {
	return detail ?? AGENT_STATE_MEANING[state];
}
