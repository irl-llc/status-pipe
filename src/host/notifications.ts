/**
 * Toast policy (design/05-ui.md "Notifications"): individually toggleable,
 * never for WAITING-lane churn, global do-not-disturb. Pure diff of
 * consecutive DisplayStates → list of toasts; the controller shows them.
 */

import { CardDisplay, DisplayState } from '../queue/displayTypes';

export interface ToastSettings {
	blocker: boolean;
	crashOrStale: boolean;
	completed: boolean;
	orphanedCi: boolean;
	doNotDisturb: boolean;
}

export interface Toast {
	kind: 'info' | 'warning';
	message: string;
}

function label(card: CardDisplay): string {
	return card.ticket ? `${card.repoName} #${card.ticket}` : card.title;
}

interface ReasonRule {
	enabled: (s: ToastSettings) => boolean;
	text: (card: CardDisplay) => string;
}

const REASON_RULES: Partial<Record<NonNullable<CardDisplay['reason']>, ReasonRule>> = {
	blocked: { enabled: (s) => s.blocker, text: (c) => c.headline || 'needs you' },
	owner: { enabled: (s) => s.blocker, text: (c) => c.headline || 'needs you' },
	'worker-crashed': { enabled: (s) => s.crashOrStale, text: (c) => c.headline || 'agent failure' },
	'stale-ack': { enabled: (s) => s.crashOrStale, text: (c) => c.headline || 'agent failure' },
	'launcher-failed': { enabled: (s) => s.crashOrStale, text: (c) => c.headline || 'agent failure' },
	'orphaned-ci': { enabled: (s) => s.orphanedCi, text: () => 'CI failing with no worker on it' },
};

function toastFor(card: CardDisplay, settings: ToastSettings): Toast | null {
	const rule = card.reason ? REASON_RULES[card.reason] : undefined;
	if (!rule || !rule.enabled(settings)) return null;
	return { kind: 'warning', message: `${label(card)}: ${rule.text(card)}` };
}

function cardToasts(card: CardDisplay, before: CardDisplay | undefined, settings: ToastSettings): Toast[] {
	const toasts: Toast[] = [];
	if (card.lane === 'needs-you' && before?.reason !== card.reason) {
		const toast = toastFor(card, settings);
		if (toast) toasts.push(toast);
	}
	if (settings.completed && card.lane === 'quiet' && before && before.lane !== 'quiet') {
		toasts.push({ kind: 'info', message: `${label(card)} completed` });
	}
	return toasts;
}

/** New NEEDS-YOU entries and fresh completions since the previous state. */
export function computeToasts(prev: DisplayState | null, next: DisplayState, settings: ToastSettings): Toast[] {
	if (settings.doNotDisturb) return [];
	const prevById = new Map((prev?.cards ?? []).map((c) => [c.id, c]));
	return next.cards.flatMap((card) => cardToasts(card, prevById.get(card.id), settings));
}
