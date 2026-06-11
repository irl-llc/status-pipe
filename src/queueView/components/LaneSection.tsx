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
			{!collapsed && cards.length === 0 && lane === 'needs-you' && (
				<div className="lane-empty">{emptyNeedsYouLine(state)}</div>
			)}
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

/** "All quiet — 3 agents running, 2 done today." — the product sentence. */
function emptyNeedsYouLine(state: DisplayState): string {
	const running = state.agents.filter((a) => a.state === 'running').length;
	const doneToday = state.cards.filter((c) => c.lane === 'quiet' && !c.hiddenByDefault).length;
	const agents = running === 1 ? '1 agent running' : `${running} agents running`;
	return `All quiet — ${agents}, ${doneToday} done today.`;
}
