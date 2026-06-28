/**
 * Unit tests for the indicator-meaning helpers (design/05-ui.md rule 6).
 * Pure functions — no DOM needed.
 */

import assert from 'node:assert/strict';

import { CardDisplay } from '../../../queue/displayTypes';
import { accentMeaning, agentStateMeaning, statusIconMeaning, waitingMeaning } from '../../../queueView/meanings';

function makeCard(overrides: Partial<CardDisplay> = {}): CardDisplay {
	return {
		id: '/repo::T-1',
		kind: 'ticket',
		repoRoot: '/repo',
		repoName: 'repo',
		ticket: 'T-1',
		title: 'Add rate limiting',
		url: null,
		phase: 'review',
		health: 'ok',
		headline: '',
		lane: 'needs-you',
		reason: null,
		priorityRank: 0,
		waiting: null,
		blockers: [],
		prs: [],
		subTickets: [],
		history: [],
		ackControl: { actionable: false, chip: null },
		worker: null,
		degraded: null,
		rawJson: null,
		epicSlug: null,
		acked: false,
		updatedAt: '2026-06-11T11:00:00.000Z',
		hiddenByDefault: false,
		...overrides,
	};
}

describe('queueView/meanings', () => {
	describe('accentMeaning', () => {
		it('names each health value in words', () => {
			const cases: Array<[CardDisplay['health'], string]> = [
				['blocked', 'Blocked — needs you'],
				['error', 'Error — needs you'],
				['waiting', 'Waiting on you or the world'],
				['ok', 'Healthy — agent working'],
				['done', 'Done'],
			];
			for (const [health, expected] of cases) {
				assert.equal(accentMeaning(makeCard({ health })), expected);
			}
		});

		it('names the stale-worker override with the heartbeat age, not the health', () => {
			const card = makeCard({
				health: 'ok',
				worker: { status: 'running', heartbeatAt: null, heartbeatAgeMs: 40 * 60_000, stale: true },
			});
			assert.equal(accentMeaning(card), 'Stale worker — no heartbeat in 40m');
		});

		it('falls back to a generic stale-worker phrase without a heartbeat age', () => {
			const card = makeCard({
				health: 'ok',
				worker: { status: 'running', heartbeatAt: null, heartbeatAgeMs: null, stale: true },
			});
			assert.equal(accentMeaning(card), 'Stale worker — no heartbeat');
		});

		it('names the stale-ack override', () => {
			assert.equal(accentMeaning(makeCard({ health: 'ok', reason: 'stale-ack' })), 'Stale ack — not picked up');
		});
	});

	describe('statusIconMeaning', () => {
		it('names done, crashed, launcher-failed and degraded; undefined when no glyph', () => {
			assert.equal(statusIconMeaning(makeCard({ health: 'done' })), 'Done');
			assert.equal(statusIconMeaning(makeCard({ reason: 'worker-crashed' })), 'Worker crashed — restart it');
			assert.equal(statusIconMeaning(makeCard({ reason: 'launcher-failed' })), 'Launcher failed — needs you');
			assert.equal(
				statusIconMeaning(makeCard({ degraded: { reason: 'corrupt', detail: 'bad json' } })),
				'Degraded — bad json',
			);
			assert.equal(statusIconMeaning(makeCard()), undefined);
		});
	});

	describe('waitingMeaning', () => {
		it('names each waiting kind in words', () => {
			assert.equal(waitingMeaning('owner'), 'Waiting on you — a reply is needed');
			assert.equal(waitingMeaning('review'), 'Waiting on review');
			assert.equal(waitingMeaning('comment'), 'Waiting on a comment reply');
			assert.equal(waitingMeaning('build'), 'Waiting on CI');
			assert.equal(waitingMeaning('merge'), 'Ready to merge — your call');
		});
	});

	describe('agentStateMeaning', () => {
		it('prefers the live detail when present', () => {
			assert.equal(agentStateMeaning('failed', 'exit 1 ×3'), 'exit 1 ×3');
		});

		it('names the run state in words when no detail is given', () => {
			assert.equal(agentStateMeaning('scheduled', null), 'Scheduled — waiting for next tick');
			assert.equal(agentStateMeaning('parked', null), 'Parked — all work waiting on you');
			assert.equal(agentStateMeaning('backoff', null), 'Backing off after a failure');
			assert.equal(agentStateMeaning('running', null), 'Running');
		});
	});
});
