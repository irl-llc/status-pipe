/**
 * jsdom + @testing-library/react tests for the queue webview components:
 * AckControl chip state machine, TicketCard anatomy and primary actions,
 * LaneSection counts/empty line, AgentsStrip summary, and PR badges.
 */

// MUST be first — installs JSDOM globals before testing-library imports.
import { installJsdomGlobals } from './reactTestHelper';

import assert from 'node:assert/strict';
import { cleanup, fireEvent, render, RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';

import { WebviewMessage } from '../../../host/webviewTypes';
import { emptyActivity } from '../../../output/claudeStream';
import {
	AckChipState,
	AgentDisplay,
	CardDisplay,
	CommentBadge,
	DisplayState,
	PrRowDisplay,
	WorkerProcessDisplay,
} from '../../../queue/displayTypes';
import { AckControl } from '../../../queueView/components/AckControl';
import { AgentsStrip } from '../../../queueView/components/AgentsStrip';
import { LaneSection } from '../../../queueView/components/LaneSection';
import { PrRows } from '../../../queueView/components/PrRows';
import { PostContext } from '../../../queueView/components/QueueApp';
import { TicketCard } from '../../../queueView/components/TicketCard';
import { formatClock } from '../../../queueView/format';
import { ACK_CHIP_ICON } from '../../../queueView/icons';

const GENERATED_AT = Date.parse('2026-06-11T12:00:00Z');

function makeCard(overrides: Partial<CardDisplay> = {}): CardDisplay {
	return {
		id: '/repo::T-1',
		kind: 'ticket',
		repoRoot: '/repo',
		repoName: 'repo',
		ticket: 'T-1',
		title: 'Add rate limiting',
		url: 'https://github.com/o/r/issues/1',
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
		acked: false,
		worker: null,
		degraded: null,
		rawJson: null,
		epicSlug: null,
		updatedAt: '2026-06-11T11:00:00.000Z',
		hiddenByDefault: false,
		...overrides,
	};
}

function makeState(overrides: Partial<DisplayState> = {}): DisplayState {
	return {
		generatedAt: GENERATED_AT,
		multiRepo: false,
		repos: [],
		agents: [],
		workers: [],
		cards: [],
		counts: { needsYou: 0, waiting: 0, quiet: 0 },
		activity: { state: 'idle', detail: null, oldestDataAgeMs: null },
		...overrides,
	};
}

function makeAgent(overrides: Partial<AgentDisplay> = {}): AgentDisplay {
	return {
		repoRoot: '/repo',
		repoName: 'repo',
		agentId: 'tick',
		title: 'Orchestrator',
		lifetime: 'scheduled',
		intervalMinutes: 10,
		installed: true,
		state: 'running',
		nextTickAt: null,
		runningSince: GENERATED_AT - 60_000,
		lastOutputAt: null,
		consecutiveFailures: 0,
		detail: null,
		activity: emptyActivity(),
		...overrides,
	};
}

function makeWorker(overrides: Partial<WorkerProcessDisplay> = {}): WorkerProcessDisplay {
	return {
		repoRoot: '/repo',
		repoName: 'repo',
		key: '19',
		runningSince: GENERATED_AT - 120_000,
		lastOutputAt: null,
		activity: emptyActivity(),
		...overrides,
	};
}

function makePr(overrides: Partial<PrRowDisplay> = {}): PrRowDisplay {
	return {
		number: 512,
		url: 'https://github.com/o/r/pull/512',
		part: 'T1a',
		head: 'rate-limit-core',
		state: 'open',
		draft: false,
		ci: 'passing',
		ciChecks: [],
		ciUrl: null,
		comments: null,
		tasks: null,
		reviewDecision: null,
		linkedTickets: [],
		upstream: 'main',
		downstream: [],
		enriched: true,
		deletedOnForge: false,
		...overrides,
	};
}

function comments(overrides: Partial<CommentBadge> = {}): CommentBadge {
	return { unresolved: 0, total: 0, resolvable: 0, prLevelResolvable: false, capped: false, ...overrides };
}

interface Rendered {
	messages: WebviewMessage[];
	result: RenderResult;
}

function renderWithPost(ui: ReactElement): Rendered {
	const messages: WebviewMessage[] = [];
	const result = render(<PostContext.Provider value={(m) => messages.push(m)}>{ui}</PostContext.Provider>);
	return { messages, result };
}

function renderCard(card: CardDisplay, state = makeState()): Rendered {
	return renderWithPost(<TicketCard card={card} state={state} selected={false} onSelect={() => undefined} />);
}

describe('queueView/components', () => {
	beforeEach(installJsdomGlobals);
	afterEach(cleanup);

	describe('AckControl', () => {
		it('renders the actionable button when applicable', () => {
			const card = makeCard({ ackControl: { actionable: true, chip: null } });
			const { result } = renderWithPost(<AckControl card={card} />);
			assert.ok(result.getByText('Ready for another look'));
		});

		it('renders neither button nor chip when inert', () => {
			const { result } = renderWithPost(<AckControl card={makeCard()} />);
			assert.equal(result.container.querySelector('button'), null);
			assert.equal(result.container.querySelector('.ack-chip'), null);
		});

		it('clicking opens the note input, and Enter posts the ack with the note', () => {
			const card = makeCard({ ackControl: { actionable: true, chip: null } });
			const { result, messages } = renderWithPost(<AckControl card={card} />);
			fireEvent.click(result.getByText('Ready for another look'));
			const input = result.getByPlaceholderText(/note for the agent/);
			fireEvent.change(input, { target: { value: 'rebased on main' } });
			fireEvent.keyDown(input, { key: 'Enter' });
			assert.deepEqual(messages, [{ type: 'ack', repoRoot: '/repo', ticket: 'T-1', note: 'rebased on main' }]);
		});

		it('posts a null note when the note is left empty', () => {
			const card = makeCard({ ackControl: { actionable: true, chip: null } });
			const { result, messages } = renderWithPost(<AckControl card={card} />);
			fireEvent.click(result.getByText('Ready for another look'));
			fireEvent.click(result.getByText('Send'));
			assert.deepEqual(messages, [{ type: 'ack', repoRoot: '/repo', ticket: 'T-1', note: null }]);
		});

		const createdAt = '2026-06-11T09:30:00.000Z';
		const chipText: Record<AckChipState, string> = {
			pending: `sent ${formatClock(createdAt)}`,
			'picked-up': 'picked up',
			superseded: 'superseded',
			'pickup-unconfirmed': 'sent · pickup unconfirmed',
			stale: 'sent — not picked up',
			'moved-on': 'state moved on since ack',
		};
		for (const state of Object.keys(chipText) as AckChipState[]) {
			it(`renders the ${state} chip with its codicon and text`, () => {
				const card = makeCard({
					ackControl: { actionable: false, chip: { state, ackId: 'a1', createdAt, note: null } },
				});
				const { result } = renderWithPost(<AckControl card={card} />);
				assert.ok(result.container.querySelector(`.ack-chip.${state} .codicon-${ACK_CHIP_ICON[state]}`));
				assert.ok(result.getByText(chipText[state]));
			});
		}

		for (const state of ['pending', 'stale'] as AckChipState[]) {
			it(`offers withdraw on a ${state} chip and posts withdrawAck`, () => {
				const card = makeCard({
					ackControl: { actionable: false, chip: { state, ackId: 'a1', createdAt, note: null } },
				});
				const { result, messages } = renderWithPost(<AckControl card={card} />);
				fireEvent.click(result.getByTitle('Withdraw this ack'));
				assert.deepEqual(messages, [{ type: 'withdrawAck', repoRoot: '/repo', ticket: 'T-1', ackId: 'a1' }]);
			});
		}

		for (const state of ['picked-up', 'superseded', 'pickup-unconfirmed', 'moved-on'] as AckChipState[]) {
			it(`offers no withdraw on a ${state} chip`, () => {
				const card = makeCard({
					ackControl: { actionable: false, chip: { state, ackId: 'a1', createdAt, note: null } },
				});
				const { result } = renderWithPost(<AckControl card={card} />);
				assert.equal(result.queryByTitle('Withdraw this ack'), null);
			});
		}
	});

	describe('TicketCard', () => {
		it('maps health to the accent class', () => {
			const cases: Array<[CardDisplay['health'], string]> = [
				['ok', 'accent-ok'],
				['waiting', 'accent-waiting'],
				['blocked', 'accent-error'],
				['error', 'accent-error'],
				['done', 'accent-done'],
			];
			for (const [health, accent] of cases) {
				const { result } = renderCard(makeCard({ health }));
				const card = result.container.querySelector('.card');
				assert.ok(card?.className.includes(accent), `${health} → ${accent}`);
				cleanup();
			}
		});

		it('overrides the accent to error for a stale worker or stale ack', () => {
			const stale = makeCard({
				health: 'ok',
				worker: { status: 'running', heartbeatAt: null, heartbeatAgeMs: null, stale: true },
			});
			assert.ok(renderCard(stale).result.container.querySelector('.card.accent-error'));
			cleanup();
			const staleAck = makeCard({ health: 'ok', reason: 'stale-ack' });
			assert.ok(renderCard(staleAck).result.container.querySelector('.card.accent-error'));
		});

		it('shows the repo badge only in multi-repo workspaces', () => {
			const multi = renderCard(makeCard(), makeState({ multiRepo: true }));
			assert.equal(multi.result.container.querySelector('.repo-badge')?.textContent, 'repo');
			cleanup();
			const single = renderCard(makeCard(), makeState({ multiRepo: false }));
			assert.equal(single.result.container.querySelector('.repo-badge'), null);
		});

		it('renders the waiting line with the kind-specific codicon', () => {
			const card = makeCard({
				waiting: {
					kind: 'build',
					ref: null,
					pr: null,
					since: '2026-06-11T10:00:00Z',
					durationMs: 120_000,
					detail: null,
				},
			});
			const { result } = renderCard(card);
			assert.ok(result.container.querySelector('.waiting-line .codicon-beaker'));
			assert.ok(result.getByText('waiting on build'));
		});

		it('renders each blocker line', () => {
			const { result } = renderCard(makeCard({ blockers: ['migration locked', 'waiting on infra'] }));
			const lines = Array.from(result.container.querySelectorAll('.blocker-line'), (el) => el.textContent);
			assert.deepEqual(lines, ['migration locked', 'waiting on infra']);
		});

		it('launcher-failed cards offer Open log and Retry wired to agentControl', () => {
			const card = makeCard({
				kind: 'launcher-failed',
				id: '/repo::launcher::orc',
				ticket: null,
				reason: 'launcher-failed',
			});
			const { result, messages } = renderCard(card);
			fireEvent.click(result.getByText('Open log'));
			fireEvent.click(result.getByText('Retry'));
			assert.deepEqual(messages, [
				{ type: 'agentControl', repoRoot: '/repo', agentId: 'orc', action: 'openLog' },
				{ type: 'agentControl', repoRoot: '/repo', agentId: 'orc', action: 'retry' },
			]);
		});

		it('degraded cards offer Open ticket file', () => {
			const card = makeCard({ degraded: { reason: 'corrupt', detail: 'bad json' }, reason: 'degraded' });
			const { result, messages } = renderCard(card);
			fireEvent.click(result.getByText('Open ticket file'));
			assert.deepEqual(messages, [{ type: 'revealTicketFile', repoRoot: '/repo', ticket: 'T-1' }]);
		});

		it('worker-crashed cards offer Restart worker', () => {
			const card = makeCard({ reason: 'worker-crashed' });
			const { result, messages } = renderCard(card);
			fireEvent.click(result.getByText('Restart worker'));
			assert.deepEqual(messages, [{ type: 'restartWorker', repoRoot: '/repo', ticket: 'T-1' }]);
		});

		it('an owner question with a ref offers Open question', () => {
			const card = makeCard({
				reason: 'owner',
				waiting: {
					kind: 'owner',
					ref: 'https://github.com/o/r/pull/1#discussion_r9',
					pr: 1,
					since: '2026-06-11T10:00:00Z',
					durationMs: 60_000,
					detail: 'agent asked about schema',
				},
			});
			const { result, messages } = renderCard(card);
			fireEvent.click(result.getByText('Open question'));
			assert.deepEqual(messages, [{ type: 'openExternal', url: 'https://github.com/o/r/pull/1#discussion_r9' }]);
		});
	});

	describe('LaneSection', () => {
		function renderLane(cards: CardDisplay[], state = makeState()): Rendered {
			return renderWithPost(
				<LaneSection
					lane="needs-you"
					title="NEEDS YOU"
					cards={cards}
					state={state}
					selectedId={null}
					onSelect={() => undefined}
				/>,
			);
		}

		it('shows the card count in the header', () => {
			const { result } = renderLane([makeCard(), makeCard({ id: '/repo::T-2', ticket: 'T-2' })]);
			assert.ok(result.getByText('NEEDS YOU (2)'));
		});

		it('renders the product sentence when needs-you is empty', () => {
			const state = makeState({
				agents: [makeAgent(), makeAgent({ agentId: 'b' }), makeAgent({ agentId: 'c', state: 'scheduled' })],
				cards: [
					makeCard({ lane: 'quiet' }),
					makeCard({ id: '/repo::T-2', lane: 'quiet' }),
					makeCard({ id: '/repo::T-3', lane: 'quiet', hiddenByDefault: true }),
				],
			});
			const { result } = renderLane([], state);
			assert.ok(result.getByText('All quiet — 2 agents running, 2 done today.'));
		});

		it('renders the parked line when needs-you is non-empty, agents parked, nothing in flight', () => {
			const cards = Array.from({ length: 4 }, (_, i) => makeCard({ id: `/repo::T-${i}`, ticket: `T-${i}` }));
			const state = makeState({
				agents: [makeAgent({ state: 'parked' })],
				counts: { needsYou: 4, waiting: 0, quiet: 0 },
			});
			const { result } = renderLane(cards, state);
			assert.ok(result.getByText('Parked — 4 items need you, nothing in flight.'));
		});

		it('suppresses the parked line while anything is still in flight', () => {
			const parked = makeAgent({ state: 'parked' });
			const running = makeAgent({ agentId: 'b', state: 'running' });
			const inFlight = makeState({ agents: [parked, running], counts: { needsYou: 1, waiting: 0, quiet: 0 } });
			const waiting = makeState({ agents: [parked], counts: { needsYou: 1, waiting: 2, quiet: 0 } });
			for (const state of [inFlight, waiting]) {
				const { result } = renderLane([makeCard()], state);
				assert.equal(result.queryByText(/^Parked —/), null);
				cleanup();
			}
		});

		it('renders nothing for an empty non-needs-you lane', () => {
			const { result } = renderWithPost(
				<LaneSection
					lane="waiting"
					title="WAITING ON WORLD"
					cards={[]}
					state={makeState()}
					selectedId={null}
					onSelect={() => undefined}
				/>,
			);
			assert.equal(result.container.innerHTML, '');
		});
	});

	describe('AgentsStrip (launch configs)', () => {
		it('renders nothing without launch configs', () => {
			const { result } = renderWithPost(<AgentsStrip state={makeState()} />);
			assert.equal(result.container.innerHTML, '');
		});

		it('aggregates the summary line by state with the soonest tick ETA', () => {
			const state = makeState({
				agents: [
					makeAgent(),
					makeAgent({ agentId: 'b', state: 'scheduled', nextTickAt: GENERATED_AT + 5 * 60_000 }),
					makeAgent({ agentId: 'c', state: 'scheduled', nextTickAt: GENERATED_AT + 10 * 60_000 }),
				],
			});
			const { result } = renderWithPost(<AgentsStrip state={state} />);
			assert.ok(result.getByText('3 launch configs: 1 running · 2 scheduled (5m)'));
		});

		it('describes a parked config with the product phrase', () => {
			const state = makeState({ agents: [makeAgent({ state: 'parked' })] });
			const { result } = renderWithPost(<AgentsStrip state={state} />);
			assert.ok(result.getByText('1 launch config: 1 parked — all work waiting on you'));
		});

		it('renders one row per config, expanded by default, with the right primary control', () => {
			const state = makeState({
				agents: [
					makeAgent({ title: 'Orchestrator' }),
					makeAgent({ agentId: 'b', title: 'Daemon B', state: 'failed', consecutiveFailures: 3, detail: 'exit 1 ×3' }),
				],
			});
			const { result, messages } = renderWithPost(<AgentsStrip state={state} />);
			// Expanded by default — no click needed to see the rows or controls.
			assert.equal(result.container.querySelectorAll('.agent-row').length, 2);
			assert.ok(result.container.querySelector('.codicon-pulse')); // running
			assert.ok(result.container.querySelector('.codicon-warning')); // failed
			assert.ok(result.getByText('exit 1 ×3'));

			fireEvent.click(result.getByTitle('Stop'));
			fireEvent.click(result.getByTitle('Retry'));
			assert.deepEqual(messages, [
				{ type: 'agentControl', repoRoot: '/repo', agentId: 'tick', action: 'stop' },
				{ type: 'agentControl', repoRoot: '/repo', agentId: 'b', action: 'retry' },
			]);
		});

		it('offers Run (not Tick/Log) for a declared-but-not-installed config and shows its cadence', () => {
			const state = makeState({
				agents: [makeAgent({ installed: false, state: 'stopped', runningSince: null, intervalMinutes: 15 })],
			});
			const { result, messages } = renderWithPost(<AgentsStrip state={state} />);
			assert.ok(result.getByText('every 15m · not started'));
			assert.equal(result.queryByTitle('Tick now'), null); // not installed → no immediate tick
			assert.equal(result.queryByTitle('Open log'), null); // no channel yet
			fireEvent.click(result.getByTitle('Run'));
			assert.deepEqual(messages, [{ type: 'agentControl', repoRoot: '/repo', agentId: 'tick', action: 'start' }]);
		});

		it('offers Tick now and Open log for an installed but idle config', () => {
			const state = makeState({
				agents: [
					makeAgent({ installed: true, state: 'scheduled', runningSince: null, nextTickAt: GENERATED_AT + 60_000 }),
				],
			});
			const { result } = renderWithPost(<AgentsStrip state={state} />);
			assert.ok(result.getByTitle('Stop')); // scheduled is "active" → Stop
			assert.ok(result.getByTitle('Tick now'));
			assert.ok(result.getByTitle('Open log'));
		});

		// Coverage boundary for the live-worker rows: these jsdom assertions are the
		// agreed floor (structure, summary text, prefix-drop, read-only, activity meta).
		// The Playwright strip snapshot — the project's no-layout-shift oracle — does NOT
		// exercise worker rows: `state.workers` comes from in-memory supervisor state
		// (workerStates()), which the e2e harness (driven from on-disk fixtures) can't
		// populate without spawning real `claude` workers. So the 30px row indent has no
		// pixel guard; if a live-worker injection seam is added later, capture a baseline.
		it('appends a worker count to the summary and renders a row per live worker', () => {
			const state = makeState({
				agents: [makeAgent({ state: 'scheduled', runningSince: null, nextTickAt: GENERATED_AT + 5 * 60_000 })],
				workers: [makeWorker({ key: '19' }), makeWorker({ key: '20' })],
			});
			const { result } = renderWithPost(<AgentsStrip state={state} />);
			assert.ok(result.getByText('1 launch config: 1 scheduled (5m) · 2 workers running'));
			const workerRows = result.container.querySelectorAll('.worker-row');
			assert.equal(workerRows.length, 2);
			assert.ok(result.getByText('19'));
			assert.ok(result.getByText('20'));
		});

		it('drops the "N launch configs" prefix when only workers are live', () => {
			const state = makeState({ agents: [], workers: [makeWorker({ key: '19' }), makeWorker({ key: '20' })] });
			const { result } = renderWithPost(<AgentsStrip state={state} />);
			assert.ok(result.getByText('2 workers running')); // not "0 launch configs: 2 workers running"
			assert.equal(result.container.querySelectorAll('.worker-row').length, 2);
		});

		it('worker rows are read-only (no Run/Stop/Tick controls)', () => {
			const state = makeState({ agents: [makeAgent()], workers: [makeWorker({ key: '19' })] });
			const { result } = renderWithPost(<AgentsStrip state={state} />);
			const row = result.container.querySelector('.worker-row');
			assert.ok(row);
			assert.equal(row?.querySelector('.agent-actions'), null);
		});

		it('shows what a worker is doing from its stream-json activity', () => {
			const activity = {
				...emptyActivity(),
				phase: 'working' as const,
				currentTool: 'Edit',
				currentToolDetail: 'lane.ts',
			};
			const state = makeState({ agents: [makeAgent()], workers: [makeWorker({ key: '19', activity })] });
			const { result } = renderWithPost(<AgentsStrip state={state} />);
			assert.ok(result.getByText('running · Edit: lane.ts'));
		});

		it('shows the current tool and target in a running agent meta (from stream-json)', () => {
			const activity = {
				...emptyActivity(),
				phase: 'working' as const,
				currentTool: 'Edit',
				currentToolDetail: 'protocol/parse.ts',
			};
			const state = makeState({ agents: [makeAgent({ state: 'running', activity })] });
			const { result } = renderWithPost(<AgentsStrip state={state} />);
			assert.ok(result.getByText('running · Edit: protocol/parse.ts'));
		});

		it('falls back to uptime for a running agent with no parsed activity', () => {
			const state = makeState({ agents: [makeAgent({ state: 'running', runningSince: GENERATED_AT - 120_000 })] });
			const { result } = renderWithPost(<AgentsStrip state={state} />);
			assert.ok(result.getByText(/^running 2m/));
		});

		it('shows Run alone (no Tick now) for an installed-but-stopped config — no double play button', () => {
			// Regression: a stopped+installed config used to render Run (play)
			// AND Tick now (run), two near-identical triangles.
			const state = makeState({ agents: [makeAgent({ installed: true, state: 'stopped', runningSince: null })] });
			const { result } = renderWithPost(<AgentsStrip state={state} />);
			assert.ok(result.getByTitle('Run'));
			assert.equal(result.queryByTitle('Tick now'), null);
			assert.ok(result.getByTitle('Open log')); // installed → still has a log
		});
	});

	describe('empty-state prompts', () => {
		function renderNeedsYou(state: DisplayState): Rendered {
			return renderWithPost(
				<LaneSection
					lane="needs-you"
					title="NEEDS YOU"
					cards={[]}
					state={state}
					selectedId={null}
					onSelect={() => undefined}
				/>,
			);
		}

		function repoDisplay(overrides: Partial<DisplayState['repos'][number]> = {}): DisplayState['repos'][number] {
			return {
				repoRoot: '/repo',
				name: 'repo',
				forgeId: 'github',
				capabilities: null,
				lastPassFinishedAt: null,
				parked: null,
				monitorOnlyNote: null,
				ticketCount: 0,
				inventoryLabel: 'agent-queue',
				inventoryAssignees: [],
				issuesUrl: 'https://github.com/acme/repo/issues',
				...overrides,
			};
		}

		it('shows the configure prompt when nothing is set up (no cards, no launch config)', () => {
			const { result, messages } = renderNeedsYou(makeState({ cards: [], agents: [] }));
			assert.ok(result.getByText('No automation configured.'));
			assert.equal(result.queryByText(/^All quiet/), null);
			fireEvent.click(result.getByText('How to configure a launch file'));
			assert.equal(messages.length, 1);
			assert.equal(messages[0].type, 'openExternal');
		});

		it('shows the empty-inventory prompt with the label + issues link when configured but no work', () => {
			const state = makeState({ cards: [], agents: [makeAgent({ state: 'stopped' })], repos: [repoDisplay()] });
			const { result, messages } = renderNeedsYou(state);
			assert.ok(result.getByText('No tracked work.'));
			assert.ok(result.getByText('agent-queue')); // the inventory label
			assert.equal(result.queryByText(/^All quiet/), null);
			fireEvent.click(result.getByText('Open issues'));
			assert.deepEqual(messages, [{ type: 'openExternal', url: 'https://github.com/acme/repo/issues' }]);
		});

		it('names the inventory assignees in the empty-inventory prompt when scoping is set', () => {
			const state = makeState({
				cards: [],
				agents: [makeAgent({ state: 'stopped' })],
				repos: [repoDisplay({ inventoryAssignees: ['ekohlwey', 'ed-irl'] })],
			});
			const { result } = renderNeedsYou(state);
			assert.ok(result.getByText(/assigned to one of/));
			assert.ok(result.getByText('ekohlwey'));
			assert.ok(result.getByText('ed-irl'));
		});

		it('omits the assignee clause when no assignee scoping is configured', () => {
			const state = makeState({ cards: [], agents: [makeAgent({ state: 'stopped' })], repos: [repoDisplay()] });
			const { result } = renderNeedsYou(state);
			assert.equal(result.queryByText(/assigned to one of/), null);
		});

		it('omits the issues link in the empty-inventory prompt when no forge is connected', () => {
			const state = makeState({
				cards: [],
				agents: [makeAgent({ state: 'stopped' })],
				repos: [repoDisplay({ issuesUrl: null })],
			});
			const { result } = renderNeedsYou(state);
			assert.ok(result.getByText('No tracked work.'));
			assert.equal(result.queryByText('Open issues'), null);
		});

		it('shows the all-quiet line (not a prompt) when needs-you is empty but other lanes have cards', () => {
			const state = makeState({ cards: [makeCard({ lane: 'quiet' })], agents: [makeAgent({ state: 'stopped' })] });
			const { result } = renderNeedsYou(state);
			assert.ok(result.getByText(/^All quiet/));
			assert.equal(result.queryByText('No tracked work.'), null);
		});
	});

	describe('PR badges (non-default only)', () => {
		function renderPr(pr: PrRowDisplay): Rendered {
			return renderWithPost(<PrRows card={makeCard({ prs: [pr] })} />);
		}

		it('renders NO badges for a passing enriched PR', () => {
			const { result } = renderPr(makePr({ ci: 'passing', comments: comments({ total: 4 }) }));
			assert.equal(result.container.querySelectorAll('.pr-badge').length, 0);
			assert.ok(result.getByText('#512'));
			assert.ok(result.getByText('rate-limit-core'));
		});

		it('renders the failing CI badge with codicon-x and opens the first failing check', () => {
			const pr = makePr({ ci: 'failing', ciUrl: 'https://ci.example/run/1' });
			const { result, messages } = renderPr(pr);
			const badge = result.container.querySelector('.pr-badge.ci-failing');
			assert.ok(badge?.querySelector('.codicon-x'));
			fireEvent.click(badge!);
			assert.deepEqual(messages, [{ type: 'openExternal', url: 'https://ci.example/run/1' }]);
		});

		it('renders the pending CI badge with codicon-clock', () => {
			const { result } = renderPr(makePr({ ci: 'pending' }));
			assert.ok(result.container.querySelector('.pr-badge.ci-pending .codicon-clock'));
		});

		it('renders the unresolved comment count badge', () => {
			const pr = makePr({ comments: comments({ unresolved: 2, total: 7, resolvable: 3 }) });
			const { result } = renderPr(pr);
			const badge = result.container.querySelector('.pr-badge');
			assert.ok(badge?.querySelector('.codicon-comment-discussion'));
			assert.equal(badge?.textContent, '2/7');
		});

		it('captions capped counts as 100+', () => {
			const pr = makePr({ comments: comments({ unresolved: 120, total: 130, resolvable: 150, capped: true }) });
			const { result } = renderPr(pr);
			assert.equal(result.container.querySelector('.pr-badge')?.textContent, '100+/130');
		});

		it('renders the changes-requested and approved badges', () => {
			const changes = renderPr(makePr({ reviewDecision: 'changes-requested' }));
			assert.ok(changes.result.container.querySelector('.pr-badge.changes-requested .codicon-request-changes'));
			cleanup();
			const approved = renderPr(makePr({ reviewDecision: 'approved' }));
			assert.ok(approved.result.container.querySelector('.pr-badge .codicon-check'));
		});

		it('renders task badges only when tasks are open', () => {
			const open = renderPr(makePr({ tasks: { unresolved: 1, total: 3 } }));
			assert.equal(open.result.container.querySelector('.pr-badge')?.textContent, '1/3');
			cleanup();
			const done = renderPr(makePr({ tasks: { unresolved: 0, total: 3 } }));
			assert.equal(done.result.container.querySelectorAll('.pr-badge').length, 0);
		});
	});

	describe('merged-collapse line', () => {
		it('counts merged and closed-unmerged PRs separately', () => {
			const card = makeCard({
				prs: [
					makePr({ number: 1, state: 'merged' }),
					makePr({ number: 2, state: 'closed' }),
					makePr({ number: 3, state: 'merged' }),
				],
			});
			const { result } = renderWithPost(<PrRows card={card} />);
			assert.ok(result.getByText('2 merged, 1 closed'));
		});
	});

	describe('card status icons (one indicator per fact)', () => {
		it('shows pass-filled on done cards and warning on crashed cards', () => {
			const done = renderCard(makeCard({ health: 'done', lane: 'quiet' }));
			assert.ok(done.result.container.querySelector('.card-status-icon.codicon-pass-filled'));
			cleanup();
			const crashed = renderCard(makeCard({ reason: 'worker-crashed' }));
			assert.ok(crashed.result.container.querySelector('.card-status-icon.codicon-warning'));
			cleanup();
			const plain = renderCard(makeCard());
			assert.equal(plain.result.container.querySelector('.card-status-icon'), null);
		});

		it('renders the circle-slash glyph on blocker lines', () => {
			const { result } = renderCard(makeCard({ blockers: ['need creds'] }));
			assert.ok(result.container.querySelector('.blocker-line .codicon-circle-slash'));
		});
	});

	describe('stack indicators', () => {
		it('renders exactly one ↑ glyph for a stacked upstream and one ↓ per downstream', () => {
			const pr = makePr({ upstream: 'T1a #855', downstream: ['T2 #861'] });
			const { result } = renderWithPost(<PrRows card={makeCard({ prs: [pr] })} />);
			const refs = Array.from(result.container.querySelectorAll('.stack-ref')).map((el) => el.textContent);
			assert.deepEqual(refs, ['↑ T1a #855', '↓ T2 #861']);
		});
	});
});
