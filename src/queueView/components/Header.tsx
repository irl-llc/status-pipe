/**
 * The fixed header row: title (or the all-quiet sentence context), filter,
 * overflow toggles, and the reserved 16×16 activity slot — the ONLY place
 * global forge/network status appears (design/05-ui.md).
 */

import { useState, type JSX } from 'react';

import { DisplayState } from '../../queue/displayTypes';
import { formatDuration } from '../format';
import { usePost, type ViewOptions } from './QueueApp';

export interface HeaderProps {
	state: DisplayState;
	options: ViewOptions;
	onOptions: (options: ViewOptions) => void;
}

export function Header({ state, options, onOptions }: HeaderProps): JSX.Element {
	const post = usePost();
	const [filtering, setFiltering] = useState(false);
	return (
		<div className="queue-header">
			{filtering ? (
				<input
					className="filter-input"
					autoFocus
					placeholder="filter…"
					value={options.filter}
					onChange={(e) => onOptions({ ...options, filter: e.target.value })}
					onKeyDown={(e) => {
						if (e.key === 'Escape') {
							onOptions({ ...options, filter: '' });
							setFiltering(false);
						}
					}}
				/>
			) : (
				<span className="title">
					Status Pipe{state.counts.needsYou > 0 ? ` — ${state.counts.needsYou} need you` : ''}
				</span>
			)}
			<button
				className={`icon-button${filtering || options.filter ? ' toggled' : ''}`}
				title="Filter"
				onClick={() => setFiltering(!filtering)}
			>
				<span className="codicon codicon-filter" />
			</button>
			<button
				className={`icon-button${options.showDone ? ' toggled' : ''}`}
				title="Show done items older than the retention window"
				onClick={() => onOptions({ ...options, showDone: !options.showDone })}
			>
				<span className="codicon codicon-eye" />
			</button>
			<ActivitySlot state={state} onClick={() => post({ type: 'refresh' })} />
		</div>
	);
}

function ActivitySlot({ state, onClick }: { state: DisplayState; onClick: () => void }): JSX.Element {
	const activity = state.activity;
	const age = activity.oldestDataAgeMs !== null ? `data age ${formatDuration(activity.oldestDataAgeMs)}` : '';
	const tooltip =
		activity.state === 'degraded'
			? `${activity.detail ?? 'degraded'} · ${age} · click to retry now`
			: `force refresh${age ? ` · ${age}` : ''}`;
	return (
		<span className="activity-slot" title={tooltip} onClick={onClick}>
			{activity.state === 'refreshing' && <span className="codicon codicon-sync codicon-modifier-spin" />}
			{activity.state === 'degraded' && <span className="codicon codicon-warning degraded" />}
			{/* idle: slot stays empty — reserved, so nothing moves */}
		</span>
	);
}
