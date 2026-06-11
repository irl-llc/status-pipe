/**
 * Unit tests for forge/budget.ts — refresh stretching thresholds and the
 * exponential / Retry-After backoff math.
 */

import assert from 'node:assert/strict';

import { backoffActive, BackoffState, nextBackoff, NO_BACKOFF, stretchFactor } from '../../../forge/budget';
import { RateInfo } from '../../../forge/http';
import { ForgeError } from '../../../forge/types';

const NOW = 1_000_000;

function rate(remaining: number | null, limit: number | null, resetAt: number | null = null): RateInfo {
	return { remaining, limit, resetAt };
}

describe('forge/budget', () => {
	describe('stretchFactor', () => {
		it('is 1 with no rate info', () => {
			assert.equal(stretchFactor(null, NOW), 1);
		});

		it('is 1 when remaining or limit is missing', () => {
			assert.equal(stretchFactor(rate(null, 5000), NOW), 1);
			assert.equal(stretchFactor(rate(50, null), NOW), 1);
		});

		it('is 1 when the limit is zero (no division blow-up)', () => {
			assert.equal(stretchFactor(rate(0, 0), NOW), 1);
		});

		it('is 1 at or above 10% remaining', () => {
			assert.equal(stretchFactor(rate(1000, 10_000), NOW), 1);
			assert.equal(stretchFactor(rate(9999, 10_000), NOW), 1);
		});

		it('is 2 below 10% remaining', () => {
			assert.equal(stretchFactor(rate(999, 10_000), NOW), 2);
			assert.equal(stretchFactor(rate(500, 10_000), NOW), 2);
		});

		it('is 4 below 5% remaining', () => {
			assert.equal(stretchFactor(rate(499, 10_000), NOW), 4);
			assert.equal(stretchFactor(rate(250, 10_000), NOW), 4);
		});

		it('is 8 below 2.5% remaining', () => {
			assert.equal(stretchFactor(rate(249, 10_000), NOW), 8);
			assert.equal(stretchFactor(rate(0, 10_000), NOW), 8);
		});

		it('resets to 1 once the window reset time has passed', () => {
			assert.equal(stretchFactor(rate(0, 10_000, NOW), NOW), 1);
			assert.equal(stretchFactor(rate(0, 10_000, NOW - 1), NOW), 1);
		});

		it('still stretches before the reset time', () => {
			assert.equal(stretchFactor(rate(0, 10_000, NOW + 1), NOW), 8);
		});
	});

	describe('nextBackoff', () => {
		const error = new ForgeError('network', 'boom');

		it('starts at 1 minute', () => {
			assert.deepEqual(nextBackoff(NO_BACKOFF, error, NOW), {
				consecutiveFailures: 1,
				until: NOW + 60_000,
			});
		});

		it('doubles per consecutive failure (1m, 2m, 4m, …)', () => {
			let state: BackoffState = NO_BACKOFF;
			const expected = [60_000, 120_000, 240_000, 480_000];
			for (const delay of expected) {
				state = nextBackoff(state, error, NOW);
				assert.equal(state.until, NOW + delay);
			}
		});

		it('caps at 15 minutes', () => {
			const state: BackoffState = { consecutiveFailures: 4, until: null };
			assert.equal(nextBackoff(state, error, NOW).until, NOW + 15 * 60_000); // 16m capped
			const deep: BackoffState = { consecutiveFailures: 20, until: null };
			assert.equal(nextBackoff(deep, error, NOW).until, NOW + 15 * 60_000);
		});

		it('lets a later Retry-After win over the exponential', () => {
			const retryAfter = NOW + 10 * 60_000;
			const limited = new ForgeError('rate-limit', 'limited', retryAfter);
			assert.equal(nextBackoff(NO_BACKOFF, limited, NOW).until, retryAfter);
		});

		it('keeps the exponential when Retry-After is earlier', () => {
			const limited = new ForgeError('rate-limit', 'limited', NOW + 1_000);
			assert.equal(nextBackoff(NO_BACKOFF, limited, NOW).until, NOW + 60_000);
		});
	});

	describe('backoffActive', () => {
		it('is false with no until', () => {
			assert.equal(backoffActive(NO_BACKOFF, NOW), false);
		});

		it('is true before until and false at/after it', () => {
			const state: BackoffState = { consecutiveFailures: 1, until: NOW + 1 };
			assert.equal(backoffActive(state, NOW), true);
			assert.equal(backoffActive(state, NOW + 1), false);
			assert.equal(backoffActive(state, NOW + 2), false);
		});
	});
});
