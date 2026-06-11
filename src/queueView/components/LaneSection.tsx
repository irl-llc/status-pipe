/**
 * A collapsible lane section with count. The empty NEEDS-YOU state renders
 * the product sentence (design/05-ui.md); its inverse renders the parked
 * line.
 */

import { useState, type JSX } from 'react';

import { CardDisplay, DisplayState, Lane } from '../../queue/displayTypes';
import { TicketCard } from './TicketCard';

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

/** Empty needs-you → the product sentence; non-empty + parked → its inverse. */
function LaneNotice({ cards, state }: { cards: CardDisplay[]; state: DisplayState }): JSX.Element | null {
	if (cards.length === 0) return <div className="lane-empty">{emptyNeedsYouLine(state)}</div>;
	const parked = parkedLine(state);
	return parked ? <div className="lane-empty">{parked}</div> : null;
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
