/**
 * A collapsible lane section with count. The empty NEEDS-YOU state renders
 * the product sentence (design/05-ui.md); its inverse renders the parked
 * line.
 */

import { useState, type JSX } from 'react';

import { CardDisplay, DisplayState, Lane } from '../../queue/displayTypes';
import { usePost } from './QueueApp';
import { TicketCard } from './TicketCard';

/** Launch & supervision reference (design/09). */
const LAUNCH_DOCS_URL = 'https://github.com/irl-llc/status-pipe/blob/main/design/09-launch-and-supervision.md';

export interface LaneSectionProps {
	lane: Lane;
	title: string;
	cards: CardDisplay[];
	state: DisplayState;
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	collapsedByDefault?: boolean;
}

export function LaneSection(props: LaneSectionProps): JSX.Element | null {
	const [collapsed, setCollapsed] = useState(props.collapsedByDefault ?? false);
	const { lane, title, cards, state } = props;
	if (lane !== 'needs-you' && cards.length === 0) return null;
	return (
		<div>
			<div className="lane-header" onClick={() => setCollapsed(!collapsed)}>
				<span className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`} />
				<span>
					{title} ({cards.length})
				</span>
			</div>
			{!collapsed && lane === 'needs-you' && <LaneNotice cards={cards} state={state} />}
			{!collapsed &&
				cards.map((card) => (
					<TicketCard
						key={card.id}
						card={card}
						state={state}
						selected={card.id === props.selectedId}
						onSelect={() => props.onSelect(card.id)}
					/>
				))}
		</div>
	);
}

/**
 * Empty needs-you → the configure prompt when nothing is set up at all,
 * otherwise the product sentence; non-empty + parked → its inverse.
 */
function LaneNotice({ cards, state }: { cards: CardDisplay[]; state: DisplayState }): JSX.Element | null {
	if (cards.length === 0) {
		if (state.cards.length === 0) {
			// Nothing tracked anywhere: no launch config → onboard; has a
			// launch config but no work → tell them how to feed the backlog.
			return state.agents.length === 0 ? <ConfigurePrompt /> : <EmptyInventoryPrompt state={state} />;
		}
		return <div className="lane-empty">{emptyNeedsYouLine(state)}</div>;
	}
	const parked = parkedLine(state);
	return parked ? <div className="lane-empty">{parked}</div> : null;
}

/** Onboarding for an unconfigured workspace (design/09): point at the docs. */
function ConfigurePrompt(): JSX.Element {
	const post = usePost();
	return (
		<div className="lane-empty configure-prompt">
			<div className="configure-title">No automation configured.</div>
			<div className="dim">
				Add a <code>.status-pipe/launch.json</code> so Status Pipe can launch and supervise this repo&apos;s agent loop
				— or just commit ticket state files to monitor an existing loop.
			</div>
			<button className="text-button" onClick={() => post({ type: 'openExternal', url: LAUNCH_DOCS_URL })}>
				How to configure a launch file
			</button>
		</div>
	);
}

/**
 * Configured (a launch config exists) but the backlog is empty — almost
 * always because no open issues carry the inventory label, so the
 * orchestrator parks. Tell the operator how to feed it.
 */
function EmptyInventoryPrompt({ state }: { state: DisplayState }): JSX.Element {
	const post = usePost();
	const repo = state.repos.length === 1 ? state.repos[0] : null;
	const label = repo?.inventoryLabel ?? 'agent-queue';
	return (
		<div className="lane-empty configure-prompt">
			<div className="configure-title">No tracked work.</div>
			<div className="dim">
				status-pipe dispatches open issues labeled <code>{label}</code> (and epics). Label some issues to give the agent
				a backlog{repo ? '' : ' in each repo'}.
			</div>
			{repo?.issuesUrl && (
				<button className="text-button" onClick={() => post({ type: 'openExternal', url: repo.issuesUrl! })}>
					Open issues
				</button>
			)}
		</div>
	);
}

/**
 * The product sentence's inverse (design/05): needs-you non-empty with
 * nothing in flight and agents parked — "Parked — 4 items need you,
 * nothing in flight."
 */
function parkedLine(state: DisplayState): string | null {
	const parked = state.agents.some((a) => a.state === 'parked');
	const active = state.agents.some((a) => a.state === 'running' || a.state === 'launching');
	if (!parked || active || state.counts.waiting > 0) return null;
	const n = state.counts.needsYou;
	const items = n === 1 ? '1 item needs' : `${n} items need`;
	return `Parked — ${items} you, nothing in flight.`;
}

/** "All quiet — 3 agents running, 2 done today." — the product sentence. */
function emptyNeedsYouLine(state: DisplayState): string {
	const running = state.agents.filter((a) => a.state === 'running').length;
	const doneToday = state.cards.filter((c) => c.lane === 'quiet' && !c.hiddenByDefault).length;
	const agents = running === 1 ? '1 agent running' : `${running} agents running`;
	return `All quiet — ${agents}, ${doneToday} done today.`;
}
