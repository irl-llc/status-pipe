/**
 * Card anatomy (design/05-ui.md): accent bar = health, header row,
 * 2-line headline, amber waiting line, red blockers, PR rows, action row
 * with one contextual primary button plus the fixed ack slot.
 */

import type { JSX } from 'react';
import { CardDisplay, DisplayState } from '../../queue/displayTypes';
import { Health } from '../../protocol/types';
import { formatAge, formatDuration, plainHeadline } from '../format';
import { WAITING_ICON } from '../icons';
import { AckControl } from './AckControl';
import { PrRows } from './PrRows';
import { usePost, useRepoFilter } from './QueueApp';

const ACCENT: Record<Health, string> = {
	blocked: 'accent-error',
	error: 'accent-error',
	waiting: 'accent-waiting',
	ok: 'accent-ok',
	done: 'accent-done',
};

function accentClass(card: CardDisplay): string {
	if (card.worker?.stale || card.reason === 'stale-ack') return 'accent-error';
	// Handed back by the operator: calm the bar — it's no longer a call to
	// action, just awaiting pickup (issue #10). Stale/lost acks fall through
	// to their health accent above and keep their alarm.
	if (card.acked) return 'accent-acked';
	return ACCENT[card.health];
}

export interface TicketCardProps {
	card: CardDisplay;
	state: DisplayState;
	selected: boolean;
	onSelect: () => void;
}

export function TicketCard({ card, state, selected, onSelect }: TicketCardProps): JSX.Element {
	return (
		<div
			className={`card ${accentClass(card)}${card.acked ? ' acked' : ''}${selected ? ' selected' : ''}`}
			onClick={onSelect}
		>
			<CardHeader card={card} state={state} />
			{card.phase && <div className="card-phase">{card.phase}</div>}
			{card.headline && (
				<div className="card-headline" title={card.headline}>
					{plainHeadline(card.headline)}
				</div>
			)}
			<WaitingLine card={card} />
			{card.blockers.map((blocker, i) => (
				<div key={i} className="blocker-line">
					<span className="codicon codicon-circle-slash" />
					{blocker}
				</div>
			))}
			<PrRows card={card} />
			<div className="action-row" onClick={(e) => e.stopPropagation()}>
				<PrimaryAction card={card} />
				<AckControl card={card} />
			</div>
		</div>
	);
}

/**
 * Status glyph for facts no other indicator carries (design/05 icon table):
 * warning for crashed/failed/degraded, pass-filled for done. Waiting kinds
 * and ack states keep their own icons — one indicator per fact.
 */
function headerIcon(card: CardDisplay): string | null {
	if (card.health === 'done') return 'pass-filled';
	if (card.degraded || card.reason === 'worker-crashed' || card.reason === 'launcher-failed') return 'warning';
	return null;
}

function CardHeader({ card, state }: { card: CardDisplay; state: DisplayState }): JSX.Element {
	const post = usePost();
	const filterToRepo = useRepoFilter();
	const icon = headerIcon(card);
	return (
		<div className="card-header">
			{icon && <span className={`codicon codicon-${icon} card-status-icon`} />}
			{state.multiRepo && (
				<span
					className="repo-badge"
					title={`filter to ${card.repoName}`}
					onClick={(e) => {
						e.stopPropagation();
						filterToRepo(card.repoRoot);
					}}
				>
					{card.repoName}
				</span>
			)}
			{card.ticket && (
				<span
					className="ticket-key"
					title={card.url ?? ''}
					onClick={(e) => {
						e.stopPropagation();
						if (card.url) post({ type: 'openExternal', url: card.url });
					}}
				>
					#{card.ticket}
				</span>
			)}
			<span className="card-title" title={card.title}>
				{card.title}
			</span>
			{card.updatedAt && <span className="card-age">{formatAge(card.updatedAt, state.generatedAt)}</span>}
		</div>
	);
}

function WaitingLine({ card }: { card: CardDisplay }): JSX.Element | null {
	const post = usePost();
	const waiting = card.waiting;
	if (!waiting) return null;
	return (
		<div
			className="waiting-line"
			onClick={(e) => {
				e.stopPropagation();
				if (waiting.ref) post({ type: 'openExternal', url: waiting.ref });
			}}
			title={waiting.ref ?? ''}
		>
			<span className={`codicon codicon-${WAITING_ICON[waiting.kind]}`} />
			<span>{waiting.detail ?? `waiting on ${waiting.kind}`}</span>
			<span className="dim">· {formatDuration(waiting.durationMs)}</span>
		</div>
	);
}

function PrimaryAction({ card }: { card: CardDisplay }): JSX.Element | null {
	if (card.kind === 'launcher-failed') return <LauncherActions card={card} />;
	if (card.degraded) return <SimpleAction card={card} kind="reveal" />;
	if (card.reason === 'worker-crashed') return <SimpleAction card={card} kind="restart" />;
	return <OpenTargetAction card={card} />;
}

function LauncherActions({ card }: { card: CardDisplay }): JSX.Element {
	const post = usePost();
	const agentId = card.id.split('::launcher::')[1] ?? '';
	const control = (action: 'openLog' | 'retry'): void =>
		post({ type: 'agentControl', repoRoot: card.repoRoot, agentId, action });
	return (
		<>
			<button className="text-button" onClick={() => control('openLog')}>
				Open log
			</button>
			<button className="text-button primary" onClick={() => control('retry')}>
				Retry
			</button>
		</>
	);
}

function SimpleAction({ card, kind }: { card: CardDisplay; kind: 'reveal' | 'restart' }): JSX.Element {
	const post = usePost();
	if (kind === 'reveal') {
		return (
			<button
				className="text-button"
				onClick={() => post({ type: 'revealTicketFile', repoRoot: card.repoRoot, ticket: card.ticket ?? '' })}
			>
				Open ticket file
			</button>
		);
	}
	return (
		<button
			className="text-button primary"
			onClick={() => post({ type: 'restartWorker', repoRoot: card.repoRoot, ticket: card.ticket ?? '' })}
		>
			Restart worker
		</button>
	);
}

function openTarget(card: CardDisplay): { url: string; label: string } | null {
	const kind = card.waiting?.kind;
	const isQuestion = kind === 'owner' || kind === 'comment';
	if (card.waiting?.ref) return { url: card.waiting.ref, label: isQuestion ? 'Open question' : 'Open PR' };
	const openPr = card.prs.find((pr) => pr.state === 'open');
	if (openPr?.url) return { url: openPr.url, label: 'Open PR' };
	return card.url ? { url: card.url, label: 'Open' } : null;
}

function OpenTargetAction({ card }: { card: CardDisplay }): JSX.Element | null {
	const post = usePost();
	const target = openTarget(card);
	if (!target) return null;
	return (
		<button className="text-button" onClick={() => post({ type: 'openExternal', url: target.url })}>
			{target.label}
		</button>
	);
}
