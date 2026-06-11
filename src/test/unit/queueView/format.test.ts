/**
 * Unit tests for queueView/format.ts — display formatting helpers.
 */

import assert from 'node:assert/strict';

import { cappedCount, formatAge, formatClock, formatDuration, plainHeadline } from '../../../queueView/format';

describe('queueView/format', () => {
	describe('formatDuration', () => {
		const cases: Array<[number, string]> = [
			[0, 'now'],
			[59_999, 'now'],
			[60_000, '1m'],
			[59 * 60_000, '59m'],
			[60 * 60_000, '1h 0m'],
			[90 * 60_000, '1h 30m'],
			[23 * 3_600_000 + 59 * 60_000, '23h 59m'],
			[24 * 3_600_000, '1d 0h'],
			[50 * 3_600_000, '2d 2h'],
		];
		for (const [ms, expected] of cases) {
			it(`formats ${ms}ms as "${expected}"`, () => {
				assert.equal(formatDuration(ms), expected);
			});
		}
	});

	describe('formatAge', () => {
		const now = Date.parse('2026-06-11T12:00:00Z');

		it('formats the age of a past timestamp', () => {
			assert.equal(formatAge('2026-06-11T10:30:00Z', now), '1h 30m');
		});

		it('clamps future timestamps to now', () => {
			assert.equal(formatAge('2026-06-11T13:00:00Z', now), 'now');
		});

		it('returns empty for an unparseable timestamp', () => {
			assert.equal(formatAge('not a date', now), '');
			assert.equal(formatAge('', now), '');
		});
	});

	describe('formatClock', () => {
		it('formats local HH:MM with zero padding', () => {
			const local = new Date(2026, 5, 11, 9, 5);
			assert.equal(formatClock(local.toISOString()), '09:05');
		});

		it('formats an afternoon time', () => {
			const local = new Date(2026, 5, 11, 23, 59);
			assert.equal(formatClock(local.toISOString()), '23:59');
		});

		it('returns empty for an unparseable timestamp', () => {
			assert.equal(formatClock('nope'), '');
		});
	});

	describe('plainHeadline', () => {
		it('strips markdown emphasis characters', () => {
			assert.equal(plainHeadline('**bold** _it_ `code` # h > q'), 'bold it code h q');
		});

		it('collapses newlines and runs of whitespace', () => {
			assert.equal(plainHeadline('line one\n\nline   two\t three'), 'line one line two three');
		});

		it('trims the result', () => {
			assert.equal(plainHeadline('  *padded*  '), 'padded');
		});

		it('passes plain text through', () => {
			assert.equal(plainHeadline('already plain'), 'already plain');
		});
	});

	describe('cappedCount', () => {
		it('renders the number when uncapped', () => {
			assert.equal(cappedCount(7, false), '7');
			assert.equal(cappedCount(0, false), '0');
		});

		it('renders 100+ when capped, regardless of the count', () => {
			assert.equal(cappedCount(150, true), '100+');
			assert.equal(cappedCount(3, true), '100+');
		});
	});
});
