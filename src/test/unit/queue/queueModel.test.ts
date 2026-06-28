/**
 * Unit tests for the queue model (src/queue/queueModel.ts) — the pure
 * derivation (tickets, acks, enrichment, supervisor state, now) →
 * DisplayState. Exercises every lane rule and the priority order from
 * design/05-ui.md "Queue semantics".
 */

import * as assert from 'assert';

import { LaunchFile, TicketFile, WaitingOn, WorkerState } from '../../../protocol/types';
import { CardDisplay } from '../../../queue/displayTypes';
import { RepoEnrichment, RepoState } from '../../../queue/queueInputs';
import { buildDisplayState } from '../../../queue/queueModel';
import {
	NOW,
	ackFor,
	corruptEntry,
	hoursAgo,
	makeAgent,
	makeConfig,
	makeInput,
	makeWorker,
	makeLaunch,
	makeOrchestrator,
	makePr,
	makePrInfo,
	makeRepo,
	makeTicket,
	minutesAgo,
	prEnrichment,
	ticketRepo,
} from './fixtures';

function waiting(overrides: Partial<WaitingOn> = {}): WaitingOn {
	return { kind: 'owner', ref: null, pr: null, since: hoursAgo(2), detail: null, ...overrides };
}

function runningWorker(heartbeatAt: string | null, startedAt: string | null = hoursAgo(3)): WorkerState {
	return { status: 'running', taskId: 'task-1', startedAt, heartbeatAt };
}

const ERROR_WORKER: WorkerState = { status: 'error', taskId: 'task-1', startedAt: null, heartbeatAt: null };

/** Builds the display state for a single ticket in a single repo and returns its card. */
function soloCard(ticket: TicketFile, repoOverrides: Partial<RepoState> = {}): CardDisplay {
	const state = buildDisplayState(makeInput([ticketRepo([ticket], repoOverrides)]));
	assert.strictEqual(state.cards.length, 1);
	return state.cards[0];
}

function assertLane(card: CardDisplay, lane: CardDisplay['lane'], reason: CardDisplay['reason']): void {
	assert.strictEqual(card.lane, lane);
	assert.strictEqual(card.reason, reason);
}

describe('queue/queueModel buildDisplayState', () => {
	describe('QUIET lane', () => {
		it('moves phase merged to QUIET', () => {
			assertLane(soloCard(makeTicket({ phase: 'merged' })), 'quiet', null);
		});

		it('moves phase abandoned to QUIET', () => {
			assertLane(soloCard(makeTicket({ phase: 'abandoned' })), 'quiet', null);
		});

		it('moves health done to QUIET', () => {
			assertLane(soloCard(makeTicket({ health: 'done' })), 'quiet', null);
		});

		it('lets QUIET win over needs-you signals on the same ticket', () => {
			const card = soloCard(makeTicket({ phase: 'merged', blockers: ['leftover note'], worker: ERROR_WORKER }));
			assertLane(card, 'quiet', null);
		});

		it('hides QUIET cards past the retention window behind the show-done filter', () => {
			assert.strictEqual(soloCard(makeTicket({ phase: 'merged', updatedAt: hoursAgo(48) })).hiddenByDefault, true);
			assert.strictEqual(soloCard(makeTicket({ phase: 'merged', updatedAt: hoursAgo(1) })).hiddenByDefault, false);
		});

		it('sorts QUIET newest-completed-first', () => {
			const older = makeTicket({ ticket: '801', phase: 'merged', updatedAt: hoursAgo(3) });
			const newer = makeTicket({ ticket: '802', phase: 'merged', updatedAt: hoursAgo(1) });
			const state = buildDisplayState(makeInput([ticketRepo([older, newer])]));
			assert.deepStrictEqual(
				state.cards.map((c) => c.ticket),
				['802', '801'],
			);
		});

		it('counts only visible QUIET cards', () => {
			const hidden = makeTicket({ ticket: '801', phase: 'merged', updatedAt: hoursAgo(48) });
			const visible = makeTicket({ ticket: '802', phase: 'merged', updatedAt: hoursAgo(1) });
			const state = buildDisplayState(makeInput([ticketRepo([hidden, visible])]));
			assert.strictEqual(state.counts.quiet, 1);
		});
	});

	describe('NEEDS YOU: launcher-failed', () => {
		it('renders a synthetic rank-0 card from a failed AgentProcessState, above everything', () => {
			const crashed = makeTicket({ worker: ERROR_WORKER });
			const agent = makeAgent({ state: 'failed', consecutiveFailures: 3, lastExitCode: 1, detail: 'spawn ENOENT' });
			const state = buildDisplayState(makeInput([ticketRepo([crashed])], [agent]));

			assert.strictEqual(state.cards[0].kind, 'launcher-failed');
			assertLane(state.cards[0], 'needs-you', 'launcher-failed');
			assert.strictEqual(state.cards[0].priorityRank, 0);
			assert.strictEqual(state.cards[0].title, 'Orchestrator launcher failing');
			assert.strictEqual(state.cards[0].headline, 'spawn ENOENT');
			assert.strictEqual(state.cards[0].repoName, 'app');
			assert.strictEqual(state.cards[1].reason, 'worker-crashed');
		});

		it('does not render cards for agents in non-failed states', () => {
			const state = buildDisplayState(makeInput([makeRepo()], [makeAgent({ state: 'running' })]));
			assert.deepStrictEqual(state.cards, []);
			assert.strictEqual(state.agents.length, 1);
		});
	});

	describe('agents strip: live workers', () => {
		it('surfaces dispatched workers joined with the repo name', () => {
			const state = buildDisplayState(
				makeInput([makeRepo()], [makeAgent()], { workers: [makeWorker({ key: '19' }), makeWorker({ key: '20' })] }),
			);
			assert.deepStrictEqual(
				state.workers.map((w) => w.key),
				['19', '20'],
			);
			assert.strictEqual(state.workers[0].repoName, 'app');
		});

		it('drops workers whose repo is no longer present', () => {
			const state = buildDisplayState(
				makeInput([makeRepo()], [], { workers: [makeWorker({ repoRoot: '/gone', key: '99' })] }),
			);
			assert.deepStrictEqual(state.workers, []);
		});
	});

	describe('NEEDS YOU: worker-crashed', () => {
		it('escalates worker.status error', () => {
			assertLane(soloCard(makeTicket({ worker: ERROR_WORKER })), 'needs-you', 'worker-crashed');
		});

		it('escalates a running worker with a heartbeat older than staleWorkerMinutes', () => {
			const card = soloCard(makeTicket({ worker: runningWorker(minutesAgo(60)) }));
			assertLane(card, 'needs-you', 'worker-crashed');
			assert.strictEqual(card.worker?.stale, true);
		});

		it('escalates a running worker with no heartbeat and no startedAt', () => {
			assertLane(soloCard(makeTicket({ worker: runningWorker(null, null) })), 'needs-you', 'worker-crashed');
		});

		it('escalates a running worker with an unparseable heartbeat', () => {
			assertLane(soloCard(makeTicket({ worker: runningWorker('not-a-date') })), 'needs-you', 'worker-crashed');
		});

		it('treats a heartbeat from the future as fresh, not stale (clock skew)', () => {
			const card = soloCard(makeTicket({ worker: runningWorker(minutesAgo(-10)) }));
			assertLane(card, 'waiting', null);
			assert.strictEqual(card.worker?.stale, false);
			assert.strictEqual(card.worker?.heartbeatAgeMs, 0);
		});
	});

	describe('NEEDS YOU: ackable classes', () => {
		it('escalates health blocked', () => {
			assertLane(soloCard(makeTicket({ health: 'blocked' })), 'needs-you', 'blocked');
		});

		it('escalates non-empty blockers[] regardless of health', () => {
			assertLane(soloCard(makeTicket({ health: 'ok', blockers: ['needs a decision'] })), 'needs-you', 'blocked');
		});

		it('escalates waitingOn.kind owner', () => {
			assertLane(soloCard(makeTicket({ waitingOn: waiting({ kind: 'owner' }) })), 'needs-you', 'owner');
		});

		it('escalates waitingOn.kind comment as owner', () => {
			assertLane(soloCard(makeTicket({ waitingOn: waiting({ kind: 'comment' }) })), 'needs-you', 'owner');
		});

		it('escalates waitingOn.kind review', () => {
			assertLane(soloCard(makeTicket({ waitingOn: waiting({ kind: 'review' }) })), 'needs-you', 'review');
		});

		it('escalates waitingOn.kind merge', () => {
			assertLane(soloCard(makeTicket({ waitingOn: waiting({ kind: 'merge' }) })), 'needs-you', 'merge');
		});
	});

	describe('NEEDS YOU: orphaned failing CI', () => {
		it('escalates an open failing PR with no worker', () => {
			const ticket = makeTicket({ prs: [makePr({ number: 855, ci: 'failing' })] });
			assertLane(soloCard(ticket), 'needs-you', 'orphaned-ci');
		});

		it('escalates an open failing PR with an idle worker', () => {
			const ticket = makeTicket({
				prs: [makePr({ number: 855, ci: 'failing' })],
				worker: { status: 'idle', taskId: null, startedAt: null, heartbeatAt: null },
			});
			assertLane(soloCard(ticket), 'needs-you', 'orphaned-ci');
		});

		it('does not escalate while phase is fixing', () => {
			const ticket = makeTicket({ phase: 'fixing', prs: [makePr({ number: 855, ci: 'failing' })] });
			assertLane(soloCard(ticket), 'waiting', null);
		});

		it('does not escalate while a worker is running with a fresh heartbeat', () => {
			const ticket = makeTicket({
				prs: [makePr({ number: 855, ci: 'failing' })],
				worker: runningWorker(minutesAgo(5)),
			});
			assertLane(soloCard(ticket), 'waiting', null);
		});

		it('does not escalate a failing PR that is no longer open', () => {
			const ticket = makeTicket({ prs: [makePr({ number: 855, ci: 'failing', state: 'closed' })] });
			assertLane(soloCard(ticket), 'waiting', null);
		});

		it('uses effective (enrichment-merged) CI: live failing checks beat a cached passing ci', () => {
			const ticket = makeTicket({ prs: [makePr({ number: 855, ci: 'passing' })] });
			const enrichment: RepoEnrichment = {
				viewerLogin: null,
				prs: {
					855: prEnrichment({ checks: { aggregate: 'failing', checks: [{ name: 'build', status: 'failing' }] } }),
				},
			};
			assertLane(soloCard(ticket, { enrichment }), 'needs-you', 'orphaned-ci');
		});
	});

	describe('Layer-2 merge CI backstop (issue #36)', () => {
		const mergeTicket = (ci: 'passing' | 'failing' | 'pending' | 'unknown', extraPrs: number[] = []): TicketFile =>
			makeTicket({
				phase: 'awaiting-merge',
				waitingOn: waiting({ kind: 'merge', pr: 855 }),
				prs: [makePr({ number: 855, ci }), ...extraPrs.map((number) => makePr({ number, ci: 'pending' }))],
			});

		it('renders merge-ready when the merge PR CI is passing', () => {
			assertLane(soloCard(mergeTicket('passing')), 'needs-you', 'merge');
		});

		it('withholds merge and surfaces orphaned-ci when the merge PR CI is failing', () => {
			assertLane(soloCard(mergeTicket('failing')), 'needs-you', 'orphaned-ci');
		});

		it('withholds merge and falls to WAITING when the merge PR CI is still pending', () => {
			assertLane(soloCard(mergeTicket('pending')), 'waiting', null);
		});

		it('withholds merge when checks never ran on head (ci unknown)', () => {
			assertLane(soloCard(mergeTicket('unknown')), 'waiting', null);
		});

		it('uses live effective CI: live pending beats a cached passing ci for the merge gate', () => {
			const enrichment: RepoEnrichment = {
				viewerLogin: null,
				prs: {
					855: prEnrichment({ checks: { aggregate: 'pending', checks: [{ name: 'build', status: 'pending' }] } }),
				},
			};
			assertLane(soloCard(mergeTicket('passing'), { enrichment }), 'waiting', null);
		});

		it('withholds merge and falls to WAITING when live checks report none (no checks on head)', () => {
			const enrichment: RepoEnrichment = {
				viewerLogin: null,
				prs: { 855: prEnrichment({ checks: { aggregate: 'none', checks: [] } }) },
			};
			assertLane(soloCard(mergeTicket('passing'), { enrichment }), 'waiting', null);
		});

		it('disables the backstop when reviewGate.requireCiGreen is false (no-CI repo)', () => {
			assertLane(
				soloCard(mergeTicket('unknown'), { config: makeConfig({ reviewGateRequireCiGreen: false }) }),
				'needs-you',
				'merge',
			);
		});

		it('opt-out still renders merge even with failing CI, never demoting to orphaned-ci', () => {
			assertLane(
				soloCard(mergeTicket('failing'), { config: makeConfig({ reviewGateRequireCiGreen: false }) }),
				'needs-you',
				'merge',
			);
		});

		it('checks only the named merge PR, ignoring other open PRs in the stack', () => {
			assertLane(soloCard(mergeTicket('passing', [860])), 'needs-you', 'merge');
		});

		it('trusts the worker when no PR row is available to judge', () => {
			assertLane(
				soloCard(makeTicket({ phase: 'awaiting-merge', waitingOn: waiting({ kind: 'merge' }) })),
				'needs-you',
				'merge',
			);
		});
	});

	describe('NEEDS YOU: degraded entries', () => {
		it('renders a corrupt entry as a degraded needs-you card with the raw JSON', () => {
			const state = buildDisplayState(makeInput([makeRepo({ tickets: [corruptEntry('999')] })]));
			const card = state.cards[0];
			assertLane(card, 'needs-you', 'degraded');
			assert.strictEqual(card.ticket, '999');
			assert.strictEqual(card.headline, 'Ticket file is corrupt.');
			assert.deepStrictEqual(card.degraded, { reason: 'corrupt', detail: 'unit fixture' });
			assert.strictEqual(card.rawJson, '{not json');
		});

		it('renders an unknown-schema entry with the update notice', () => {
			const state = buildDisplayState(makeInput([makeRepo({ tickets: [corruptEntry('999', 'unknown-schema')] })]));
			assert.strictEqual(state.cards[0].headline, 'Unknown schema version — update status-pipe.');
			assert.deepStrictEqual(state.cards[0].degraded, { reason: 'unknown-schema', detail: 'unit fixture' });
		});
	});

	describe('priority order within NEEDS YOU', () => {
		it('orders launcher-failed < worker-crashed < stale-ack < blocked < owner < review < merge < orphaned-ci < degraded', () => {
			const staleAckTicket = makeTicket({ ticket: '2', waitingOn: waiting({ since: hoursAgo(4) }) });
			const repo = makeRepo({
				tickets: [
					makeTicket({ ticket: '1', worker: ERROR_WORKER }),
					staleAckTicket,
					makeTicket({ ticket: '3', health: 'blocked' }),
					makeTicket({ ticket: '4', waitingOn: waiting({ kind: 'owner' }) }),
					makeTicket({ ticket: '5', waitingOn: waiting({ kind: 'review' }) }),
					makeTicket({ ticket: '6', waitingOn: waiting({ kind: 'merge' }) }),
					makeTicket({ ticket: '7', prs: [makePr({ number: 855, ci: 'failing' })] }),
				].map((t) => ({ key: t.ticket, parsed: { ok: true as const, value: t } })),
				acks: [ackFor(staleAckTicket, hoursAgo(3))],
				orchestrator: makeOrchestrator({ lastPassStartedAt: hoursAgo(1), lastPassFinishedAt: minutesAgo(30) }),
			});
			repo.tickets.push(corruptEntry('8'));
			const agent = makeAgent({ state: 'failed', consecutiveFailures: 2 });

			const state = buildDisplayState(makeInput([repo], [agent]));
			assert.deepStrictEqual(
				state.cards.map((c) => c.reason),
				[
					'launcher-failed',
					'worker-crashed',
					'stale-ack',
					'blocked',
					'owner',
					'review',
					'merge',
					'orphaned-ci',
					'degraded',
				],
			);
			assert.ok(state.cards.every((c) => c.lane === 'needs-you'));
		});
	});

	describe('review demotion', () => {
		const reviewTicket = (): TicketFile => makeTicket({ waitingOn: waiting({ kind: 'review', pr: 855 }) });

		function reviewEnrichment(reviewRequests: string[] | undefined): RepoEnrichment {
			return {
				viewerLogin: 'ed',
				prs: { 855: prEnrichment({ info: makePrInfo({ number: 855, reviewRequests }) }) },
			};
		}

		it('demotes to WAITING when the review is attributably someone else’s', () => {
			const card = soloCard(reviewTicket(), { enrichment: reviewEnrichment(['someone-else']) });
			assertLane(card, 'waiting', null);
		});

		it('stays NEEDS YOU when the viewer is among the requested reviewers', () => {
			const card = soloCard(reviewTicket(), { enrichment: reviewEnrichment(['someone-else', 'ed']) });
			assertLane(card, 'needs-you', 'review');
		});

		it('stays NEEDS YOU without enrichment (false positives beat starvation)', () => {
			assertLane(soloCard(reviewTicket()), 'needs-you', 'review');
		});

		it('stays NEEDS YOU when enrichment carries no review requests', () => {
			assertLane(soloCard(reviewTicket(), { enrichment: reviewEnrichment([]) }), 'needs-you', 'review');
		});
	});

	describe('WAITING lane', () => {
		it('keeps waitingOn.kind build in WAITING', () => {
			assertLane(soloCard(makeTicket({ waitingOn: waiting({ kind: 'build' }) })), 'waiting', null);
		});

		it('keeps a running worker with a fresh heartbeat in WAITING', () => {
			assertLane(soloCard(makeTicket({ worker: runningWorker(minutesAgo(5)) })), 'waiting', null);
		});

		it('defaults a ticket with no signals to WAITING', () => {
			assertLane(soloCard(makeTicket()), 'waiting', null);
		});

		it('keeps a hardening ticket with a fresh worker in WAITING (active, nothing needs you)', () => {
			const ticket = makeTicket({ phase: 'hardening', worker: runningWorker(minutesAgo(2)) });
			assertLane(soloCard(ticket), 'waiting', null);
		});
	});

	describe('ack suppression', () => {
		it('suppresses owner with a fresh pending ack → WAITING with a pending chip', () => {
			const ticket = makeTicket({ waitingOn: waiting({ kind: 'owner' }) });
			const card = soloCard(ticket, { acks: [ackFor(ticket, minutesAgo(5))] });
			assertLane(card, 'waiting', null);
			assert.strictEqual(card.ackControl.chip?.state, 'pending');
			assert.strictEqual(card.ackControl.actionable, false);
			// A handed-back card is flagged acked → calm visuals + WAITING demotion.
			assert.strictEqual(card.acked, true);
			assert.strictEqual(card.priorityRank, 60);
		});

		it('flags a picked-up ack as acked once the card has left NEEDS YOU', () => {
			// Ack against the old owner-question; the agent picked it up and the
			// ticket advanced to a WAITING kind (build). The picked-up chip plus
			// the WAITING lane = calm.
			const acked = makeTicket({ waitingOn: waiting({ kind: 'owner', since: hoursAgo(2) }) });
			const known = ackFor(acked, hoursAgo(1), false);
			const ticket = {
				...makeTicket({ waitingOn: waiting({ kind: 'build', since: minutesAgo(20) }) }),
				history: [{ at: minutesAgo(10), phase: null, note: `consumed ack ${known.ack.ackId}`, runId: null }],
			};
			const card = soloCard(ticket, { acks: [known] });
			assert.strictEqual(card.ackControl.chip?.state, 'picked-up');
			assertLane(card, 'waiting', null);
			assert.strictEqual(card.acked, true);
		});

		it('does NOT calm a picked-up ack while the ticket still waits on the owner', () => {
			// Agent re-looked, recorded the pickup, but still needs the operator —
			// keep the alarm (stays in NEEDS YOU, acked=false).
			const base = makeTicket({ waitingOn: waiting({ kind: 'owner' }) });
			const known = ackFor(base, hoursAgo(1), false);
			const ticket = {
				...base,
				history: [{ at: minutesAgo(10), phase: null, note: `consumed ack ${known.ack.ackId}`, runId: null }],
			};
			const card = soloCard(ticket, { acks: [known] });
			assert.strictEqual(card.ackControl.chip?.state, 'picked-up');
			assertLane(card, 'needs-you', 'owner');
			assert.strictEqual(card.acked, false);
		});

		it('does NOT flag stale / pickup-unconfirmed / superseded acks as acked', () => {
			const owner = (): TicketFile => makeTicket({ waitingOn: waiting({ kind: 'owner' }) });
			const stale = soloCard(owner(), {
				acks: [ackFor(owner(), hoursAgo(2))],
				orchestrator: makeOrchestrator({ lastPassStartedAt: hoursAgo(1), lastPassFinishedAt: minutesAgo(30) }),
			});
			assert.strictEqual(stale.acked, false);
			const unconfirmed = soloCard(owner(), { acks: [ackFor(owner(), hoursAgo(1), false)] });
			assert.strictEqual(unconfirmed.acked, false);
		});

		it('does NOT calm off an older ack when the newest ack has moved on', () => {
			// An older fresh-pending ack (matches the current owner question) keeps
			// the card in WAITING; a newer ack targets a now-superseded state →
			// moved-on, the chip the operator actually sees. The card must NOT calm:
			// isAcked evaluates the newest ack only, matching the chip from
			// deriveAckControl (gemini flag on PR #27). `acks.some(...)` calmed it
			// off the older pending entry while the visible chip showed a warning.
			const current = makeTicket({ waitingOn: waiting({ kind: 'owner', since: minutesAgo(30) }) });
			const pending = ackFor(current, minutesAgo(8));
			const movedOn = ackFor(makeTicket({ waitingOn: waiting({ kind: 'owner', since: hoursAgo(5) }) }), minutesAgo(3));
			const card = soloCard(current, { acks: [pending, movedOn] });
			assertLane(card, 'waiting', null);
			assert.strictEqual(card.ackControl.chip?.state, 'moved-on');
			assert.strictEqual(card.acked, false);
		});

		it('does NOT flag a QUIET (done) card as acked — done keeps its own treatment', () => {
			// Ackable (has a leftover blocker) but merged → QUIET wins; the calm
			// state is WAITING-only, so QUIET keeps its done treatment.
			const done = makeTicket({ phase: 'merged', blockers: ['leftover note'] });
			const card = soloCard(done, { acks: [ackFor(done, minutesAgo(5))] });
			assertLane(card, 'quiet', null);
			assert.strictEqual(card.acked, false);
		});

		it('suppresses blocked with a fresh pending ack against the blockers target', () => {
			const ticket = makeTicket({ blockers: ['waiting on a decision'] });
			const card = soloCard(ticket, { acks: [ackFor(ticket, minutesAgo(5))] });
			assertLane(card, 'waiting', null);
		});

		it('does NOT suppress worker-crashed', () => {
			const ticket = makeTicket({ waitingOn: waiting({ kind: 'owner' }), worker: ERROR_WORKER });
			const card = soloCard(ticket, { acks: [ackFor(ticket, minutesAgo(5))] });
			assertLane(card, 'needs-you', 'worker-crashed');
			// Crash overrides the ack — the card is not "handed back, all good".
			assert.strictEqual(card.acked, false);
		});

		it('sinks an acked WAITING card below an un-acked one (issue #10 reorder)', () => {
			const acked = makeTicket({ ticket: '1', waitingOn: waiting({ kind: 'owner', since: hoursAgo(4) }) });
			const unacked = makeTicket({ ticket: '2', waitingOn: waiting({ kind: 'build', since: hoursAgo(1) }) });
			const state = buildDisplayState(
				makeInput([ticketRepo([acked, unacked], { acks: [ackFor(acked, minutesAgo(5))] })]),
			);
			// Both WAITING; despite the acked one being older, it sorts last.
			assert.deepStrictEqual(
				state.cards.map((c) => c.ticket),
				['2', '1'],
			);
		});
	});

	describe('stale acks', () => {
		it('escalates when an orchestrator pass completed after the ack without consuming it', () => {
			const ticket = makeTicket({ waitingOn: waiting({ kind: 'owner' }) });
			const card = soloCard(ticket, {
				acks: [ackFor(ticket, hoursAgo(2))],
				orchestrator: makeOrchestrator({ lastPassStartedAt: hoursAgo(1), lastPassFinishedAt: minutesAgo(30) }),
			});
			assertLane(card, 'needs-you', 'stale-ack');
			assert.strictEqual(card.ackControl.chip?.state, 'stale');
			assert.strictEqual(card.ackControl.actionable, false);
		});

		it('escalates with no pass info when the ack is older than 2× the launch tick interval', () => {
			const ticket = makeTicket({ waitingOn: waiting({ kind: 'owner' }) });
			const card = soloCard(ticket, { acks: [ackFor(ticket, minutesAgo(45))], launch: makeLaunch(10) });
			assertLane(card, 'needs-you', 'stale-ack');
		});

		it('keeps a younger ack pending (WAITING) under the same tick interval', () => {
			const ticket = makeTicket({ waitingOn: waiting({ kind: 'owner' }) });
			const card = soloCard(ticket, { acks: [ackFor(ticket, minutesAgo(15))], launch: makeLaunch(10) });
			assertLane(card, 'waiting', null);
			assert.strictEqual(card.ackControl.chip?.state, 'pending');
		});

		it('does not treat a pass that started before the ack as staleness', () => {
			const ticket = makeTicket({ waitingOn: waiting({ kind: 'owner' }) });
			const card = soloCard(ticket, {
				acks: [ackFor(ticket, minutesAgo(5))],
				orchestrator: makeOrchestrator({ lastPassStartedAt: hoursAgo(1), lastPassFinishedAt: minutesAgo(50) }),
			});
			assertLane(card, 'waiting', null);
			assert.strictEqual(card.ackControl.chip?.state, 'pending');
		});
	});

	describe('ack chips', () => {
		const ownerTicket = (): TicketFile => makeTicket({ waitingOn: waiting({ kind: 'owner' }) });

		function withHistoryNote(ticket: TicketFile, note: string): TicketFile {
			return { ...ticket, history: [{ at: minutesAgo(10), phase: null, note, runId: null }] };
		}

		it('shows picked-up when the ack file is gone and history names the ackId', () => {
			const base = ownerTicket();
			const known = ackFor(base, hoursAgo(1), false);
			const ticket = withHistoryNote(base, `consumed ack ${known.ack.ackId}`);
			const card = soloCard(ticket, { acks: [known] });
			assert.strictEqual(card.ackControl.chip?.state, 'picked-up');
		});

		it('shows picked-up even while the file is still present once history names the ackId', () => {
			const base = ownerTicket();
			const known = ackFor(base, hoursAgo(1), true);
			const ticket = withHistoryNote(base, `consumed ack ${known.ack.ackId}`);
			const card = soloCard(ticket, { acks: [known] });
			assert.strictEqual(card.ackControl.chip?.state, 'picked-up');
		});

		it('shows superseded when the history note names the ackId and says superseded', () => {
			const base = ownerTicket();
			const known = ackFor(base, hoursAgo(1), false);
			const ticket = withHistoryNote(base, `ack ${known.ack.ackId} superseded by a newer request`);
			const card = soloCard(ticket, { acks: [known] });
			assert.strictEqual(card.ackControl.chip?.state, 'superseded');
		});

		it('shows pickup-unconfirmed for a memory-only ack with no history entry', () => {
			const ticket = ownerTicket();
			const card = soloCard(ticket, { acks: [ackFor(ticket, hoursAgo(1), false)] });
			assert.strictEqual(card.ackControl.chip?.state, 'pickup-unconfirmed');
			// pickup-unconfirmed must not suppress: the request still needs the operator.
			assertLane(card, 'needs-you', 'owner');
		});

		it('shows moved-on for an on-disk ack whose target no longer matches', () => {
			const old = makeTicket({ waitingOn: waiting({ kind: 'owner', since: hoursAgo(3) }) });
			const known = ackFor(old, hoursAgo(3));
			const current = makeTicket({ waitingOn: waiting({ kind: 'owner', since: hoursAgo(1) }) });
			const card = soloCard(current, { acks: [known] });
			assert.strictEqual(card.ackControl.chip?.state, 'moved-on');
			assertLane(card, 'needs-you', 'owner');
			assert.strictEqual(card.ackControl.actionable, true);
		});

		it('is actionable with no chip when an ackable target exists and no ack was sent', () => {
			const card = soloCard(ownerTicket());
			assert.deepStrictEqual(card.ackControl, { actionable: true, chip: null });
		});

		it('is not actionable when the ticket has nothing to ack', () => {
			const card = soloCard(makeTicket());
			assert.deepStrictEqual(card.ackControl, { actionable: false, chip: null });
		});
	});

	describe('tie-breaks within the same rank', () => {
		it('orders by oldest waitingOn.since, then repo name, then ticket key', () => {
			const owner = (ticket: string, since: string): TicketFile =>
				makeTicket({ ticket, waitingOn: waiting({ kind: 'owner', since }) });
			const zeta = ticketRepo([owner('900', hoursAgo(5))], { repoRoot: '/work/zeta', name: 'zeta' });
			const alpha = ticketRepo([owner('500', hoursAgo(2)), owner('400', hoursAgo(2))], {
				repoRoot: '/work/alpha',
				name: 'alpha',
			});
			const beta = ticketRepo([owner('100', hoursAgo(2))], { repoRoot: '/work/beta', name: 'beta' });

			const state = buildDisplayState(makeInput([zeta, alpha, beta]));
			assert.ok(state.cards.every((c) => c.reason === 'owner' && c.priorityRank === state.cards[0].priorityRank));
			assert.deepStrictEqual(
				state.cards.map((c) => `${c.repoName}/${c.ticket}`),
				['zeta/900', 'alpha/400', 'alpha/500', 'beta/100'],
			);
		});
	});

	describe('staleWorkerMinutes resolution precedence', () => {
		const tenMinuteHeartbeat = (): TicketFile => makeTicket({ worker: runningWorker(minutesAgo(10)) });

		function laneWith(repoOverrides: Partial<RepoState>, settingsDefault: number): CardDisplay {
			const input = makeInput([ticketRepo([tenMinuteHeartbeat()], repoOverrides)], [], {
				settings: { staleWorkerMinutesDefault: settingsDefault },
			});
			return buildDisplayState(input).cards[0];
		}

		it('falls back to the settings default when neither orchestrator nor config sets it', () => {
			assertLane(laneWith({}, 5), 'needs-you', 'worker-crashed');
			assertLane(laneWith({}, 30), 'waiting', null);
		});

		it('prefers config.staleWorkerMinutes over the settings default', () => {
			const config = makeConfig({ staleWorkerMinutes: 60 });
			assertLane(laneWith({ config }, 5), 'waiting', null);
		});

		it('prefers orchestrator.staleWorkerMinutes over config and default', () => {
			const repo: Partial<RepoState> = {
				orchestrator: makeOrchestrator({ staleWorkerMinutes: 5 }),
				config: makeConfig({ staleWorkerMinutes: 60 }),
			};
			assertLane(laneWith(repo, 60), 'needs-you', 'worker-crashed');
		});
	});

	describe('stack indicators and PR enrichment overlay', () => {
		it('derives upstream/downstream labels across different tickets in the same repo', () => {
			const t1 = makeTicket({
				ticket: '853',
				prs: [makePr({ number: 855, head: 'feat-1a', base: 'main', part: 'T1a' })],
			});
			const t2 = makeTicket({
				ticket: '860',
				prs: [makePr({ number: 861, head: 'feat-2', base: 'feat-1a', part: 'T2' })],
			});
			const state = buildDisplayState(makeInput([ticketRepo([t1, t2])]));

			const card853 = state.cards.find((c) => c.ticket === '853');
			const card860 = state.cards.find((c) => c.ticket === '860');
			assert.strictEqual(card853?.prs[0].upstream, 'main');
			assert.deepStrictEqual(card853?.prs[0].downstream, ['T2 #861']);
			// Bare label — the view owns the ↑ glyph (model+view each adding one
			// shipped a doubled "↑ ↑" once).
			assert.strictEqual(card860?.prs[0].upstream, 'T1a #855');
			assert.deepStrictEqual(card860?.prs[0].downstream, []);
		});

		it('overlays enrichment: merged state, aggregated checks, comment badge with capped flag', () => {
			const ticket = makeTicket({ prs: [makePr({ number: 855, state: 'open', ci: 'passing' })] });
			const enrichment: RepoEnrichment = {
				viewerLogin: null,
				prs: {
					855: prEnrichment({
						info: makePrInfo({
							number: 855,
							state: 'merged',
							comments: { total: 7, resolvable: 3, unresolved: 2, prLevelResolvable: false, capped: true },
						}),
						checks: { aggregate: 'failing', checks: [{ name: 'build', status: 'failing', url: 'https://ci/run/1' }] },
					}),
				},
			};
			const row = soloCard(ticket, { enrichment }).prs[0];
			assert.strictEqual(row.state, 'merged');
			assert.strictEqual(row.ci, 'failing');
			assert.strictEqual(row.ciUrl, 'https://ci/run/1');
			assert.strictEqual(row.enriched, true);
			assert.deepStrictEqual(row.comments, {
				unresolved: 2,
				total: 7,
				resolvable: 3,
				prLevelResolvable: false,
				capped: true,
			});
		});

		it('renders the worker’s cached view untouched when there is no enrichment', () => {
			const row = soloCard(makeTicket({ prs: [makePr({ number: 855, ci: 'passing' })] })).prs[0];
			assert.strictEqual(row.ci, 'passing');
			assert.strictEqual(row.enriched, false);
			assert.strictEqual(row.comments, null);
		});
	});

	describe('top-level display state', () => {
		it('counts needsYou, waiting, and visible quiet', () => {
			const repo = ticketRepo([
				makeTicket({ ticket: '1', waitingOn: waiting({ kind: 'owner' }) }),
				makeTicket({ ticket: '2', waitingOn: waiting({ kind: 'build' }) }),
				makeTicket({ ticket: '3', phase: 'merged', updatedAt: hoursAgo(1) }),
				makeTicket({ ticket: '4', phase: 'merged', updatedAt: hoursAgo(48) }),
			]);
			const state = buildDisplayState(makeInput([repo]));
			assert.deepStrictEqual(state.counts, { needsYou: 1, waiting: 1, quiet: 1 });
		});

		it('sets multiRepo only when more than one repo is scanned', () => {
			assert.strictEqual(buildDisplayState(makeInput([makeRepo()])).multiRepo, false);
			const two = [makeRepo(), makeRepo({ repoRoot: '/work/other', name: 'other' })];
			assert.strictEqual(buildDisplayState(makeInput(two)).multiRepo, true);
		});

		it('annotates monitor-only repos (worktree open without its primary)', () => {
			const state = buildDisplayState(makeInput([makeRepo({ monitorOnly: true })]));
			assert.strictEqual(state.repos[0].monitorOnlyNote, 'worktree of app — supervision disabled');
			assert.strictEqual(buildDisplayState(makeInput([makeRepo()])).repos[0].monitorOnlyNote, null);
		});
	});

	describe('launch config rows', () => {
		it('surfaces a declared config with no runner as a stopped, not-installed row', () => {
			// launch.json declares it, but the supervisor never installed it
			// (e.g. not yet approved) — no matching AgentProcessState.
			const repo = makeRepo({ launch: makeLaunch(15) });
			const state = buildDisplayState(makeInput([repo], []));
			assert.strictEqual(state.agents.length, 1);
			const row = state.agents[0];
			assert.strictEqual(row.agentId, 'tick');
			assert.strictEqual(row.state, 'stopped');
			assert.strictEqual(row.installed, false);
			assert.strictEqual(row.intervalMinutes, 15);
		});

		it('joins a declared config with its live runner state (installed)', () => {
			const repo = makeRepo({ launch: makeLaunch(10) });
			const live = makeAgent({ state: 'running', runningSince: NOW - 60_000 });
			const row = buildDisplayState(makeInput([repo], [live])).agents[0];
			assert.strictEqual(row.installed, true);
			assert.strictEqual(row.state, 'running');
			assert.strictEqual(row.runningSince, NOW - 60_000);
			assert.strictEqual(row.intervalMinutes, 10); // from the declared config, not the runner
		});

		it('keeps a live runner whose config was removed from launch.json (orphan), marked installed', () => {
			// No launch file, but a runner still exists — never silently drop it.
			const repo = makeRepo({ launch: null });
			const live = makeAgent({ state: 'running' });
			const rows = buildDisplayState(makeInput([repo], [live])).agents;
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0].installed, true);
			assert.strictEqual(rows[0].intervalMinutes, null);
		});

		it('shows no launcher rows for a monitor-only worktree (supervision disabled)', () => {
			const repo = makeRepo({ monitorOnly: true, launch: makeLaunch(10) });
			assert.deepStrictEqual(buildDisplayState(makeInput([repo], [])).agents, []);
		});

		it('reports null intervalMinutes for a declared daemon config', () => {
			const launch: LaunchFile = {
				schemaVersion: 1,
				agents: [{ ...makeLaunch().agents[0], id: 'd', lifetime: 'daemon' }],
			};
			const row = buildDisplayState(makeInput([makeRepo({ launch })], [])).agents[0];
			assert.strictEqual(row.lifetime, 'daemon');
			assert.strictEqual(row.intervalMinutes, null);
		});
	});
});
