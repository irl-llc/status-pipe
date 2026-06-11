/**
 * Rate-budget math (design/03-forge.md "Budgeting and backoff") — pure,
 * deterministic, the tested invariant behind "a fleet of 30 PRs idles at a
 * few requests per minute".
 */

import { RateInfo } from './http';
import { ForgeError } from './types';

/** Below this fraction of budget remaining, refresh intervals stretch. */
const STRETCH_THRESHOLD = 0.1;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 15 * 60_000;

/**
 * Stretch factor for the periodic refresh interval: ×2 under 10% budget
 * remaining, ×4 under 5%, ×8 under 2.5%, until the reset time passes.
 */
export function stretchFactor(rate: RateInfo | null, now: number): number {
	if (!rate || rate.remaining === null || rate.limit === null || rate.limit === 0) return 1;
	if (rate.resetAt !== null && now >= rate.resetAt) return 1;
	const fraction = rate.remaining / rate.limit;
	if (fraction >= STRETCH_THRESHOLD) return 1;
	if (fraction >= STRETCH_THRESHOLD / 2) return 2;
	if (fraction >= STRETCH_THRESHOLD / 4) return 4;
	return 8;
}

export interface BackoffState {
	consecutiveFailures: number;
	/** Epoch ms before which no request may be sent. */
	until: number | null;
}

export const NO_BACKOFF: BackoffState = { consecutiveFailures: 0, until: null };

/**
 * Next backoff after a failure: exponential (1m, 2m, 4m … cap 15m), but a
 * rate-limit Retry-After always wins when later.
 */
export function nextBackoff(state: BackoffState, error: ForgeError, now: number): BackoffState {
	const failures = state.consecutiveFailures + 1;
	const exponential = now + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
	const until = error.retryAfter !== null ? Math.max(error.retryAfter, exponential) : exponential;
	return { consecutiveFailures: failures, until };
}

export function backoffActive(state: BackoffState, now: number): boolean {
	return state.until !== null && now < state.until;
}
