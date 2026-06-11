/**
 * Editor-mode right pane (design/05-ui.md "Editor tab"): full headline,
 * worker liveness, PR table, sub-tickets, history timeline, raw-JSON peek.
 */

import type { JSX } from 'react';
import { CardDisplay, DisplayState, PrRowDisplay } from '../../queue/displayTypes';
import { formatAge, formatDuration } from '../format';
import { AckControl } from './AckControl';
import { usePost } from './QueueApp';

export function DetailPane({ card, state }: { card: CardDisplay; state: DisplayState }): JSX.Element {
	return (
		<div>
			<DetailHeader card={card} state={state} />
			{card.headline && <p>{card.headline}</p>}
			{card.blockers.map((blocker, i) => (
				<div key={i} className="blocker-line">
					{blocker}
				</div>
			))}
			<WorkerLine card={card} />
			{card.prs.length > 0 && <PrTable card={card} prs={card.prs} />}
			{card.subTickets.length > 0 && <SubTickets card={card} />}
			{card.history.length > 0 && <Timeline card={card} />}
			{card.rawJson && (
				<div className="detail-section">
					<h3>Raw ticket file</h3>
					<pre className="raw-json">{card.rawJson}</pre>
				</div>
			)}
			<DetailLinks card={card} />
		</div>
	);
}

function DetailHeader({ card, state }: { card: CardDisplay; state: DisplayState }): JSX.Element {
	const post = usePost();
	const repo = state.repos.find((r) => r.repoRoot === card.repoRoot);
	const lastRan = repo?.lastPassFinishedAt
		? ` · orchestrator last ran ${formatAge(repo.lastPassFinishedAt, state.generatedAt)} ago`
		: '';
	return (
		<>
			<div className="card-header">
				<span className="repo-badge">{card.repoName}</span>
				{card.ticket && (
					<span className="ticket-key" onClick={() => card.url && post({ type: 'openExternal', url: card.url })}>
						#{card.ticket}
					</span>
				)}
				<span className="card-title">{card.title}</span>
				<AckControl card={card} />
			</div>
			{card.phase && (
				<div className="card-phase">
					{card.phase}
					{lastRan}
				</div>
			)}
		</>
	);
}

function DetailLinks({ card }: { card: CardDisplay }): JSX.Element {
	const post = usePost();
	return (
		<div className="detail-section">
			<button
				className="text-button"
				onClick={() => post({ type: 'revealTicketFile', repoRoot: card.repoRoot, ticket: card.ticket ?? '' })}
			>
				Open ticket file
			</button>{' '}
			{card.epicSlug && (
				<button
					className="text-button"
					onClick={() => post({ type: 'openEpicFile', repoRoot: card.repoRoot, slug: card.epicSlug! })}
				>
					Open epic file
				</button>
			)}
		</div>
	);
}

function WorkerLine({ card }: { card: CardDisplay }): JSX.Element | null {
	const worker = card.worker;
	if (!worker) return null;
	const beat =
		worker.heartbeatAgeMs !== null ? `heartbeat ${formatDuration(worker.heartbeatAgeMs)} ago` : 'no heartbeat';
	return (
		<div className="detail-section">
			<h3>Worker</h3>
			<span className={worker.stale || worker.status === 'error' ? 'blocker-line' : ''}>
				{worker.status}
				{worker.stale ? ' (stale)' : ''} · {beat}
			</span>
		</div>
	);
}

function PrTable({ card, prs }: { card: CardDisplay; prs: PrRowDisplay[] }): JSX.Element {
	const post = usePost();
	const hasTasks = prs.some((pr) => pr.tasks !== null);
	return (
		<div className="detail-section">
			<h3>Pull requests</h3>
			<table className="detail-table">
				<thead>
					<tr>
						<th>PR</th>
						<th>branch</th>
						<th>checks</th>
						<th>comments</th>
						{hasTasks && <th>tasks</th>}
						<th>review</th>
						<th>tickets</th>
					</tr>
				</thead>
				<tbody>
					{prs.map((pr) => (
						<tr key={pr.number}>
							<td>
								<span className="pr-number" onClick={() => pr.url && post({ type: 'openExternal', url: pr.url })}>
									#{pr.number}
								</span>{' '}
								{pr.part && <span className="pr-part">{pr.part}</span>} <span className="dim">{pr.state}</span>
							</td>
							<td>
								<div className="stack-ref">↑ {pr.upstream}</div>
								{pr.head}
								{pr.downstream.length > 0 && <div className="stack-ref">↓ {pr.downstream.join(', ')}</div>}
							</td>
							<td>{checksCell(pr)}</td>
							<td>{pr.comments ? `${pr.comments.unresolved}/${pr.comments.total}` : '—'}</td>
							{hasTasks && <td>{pr.tasks ? `${pr.tasks.unresolved}/${pr.tasks.total}` : '—'}</td>}
							<td>{pr.reviewDecision ?? '—'}</td>
							<td>
								{pr.linkedTickets
									.filter((t) => t.key !== card.ticket)
									.map((t) => t.key)
									.join(', ') || '—'}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function checksCell(pr: PrRowDisplay): string {
	if (pr.ciChecks.length === 0) return pr.ci === 'none' || pr.ci === 'unknown' ? '—' : pr.ci;
	const failing = pr.ciChecks.filter((c) => c.status === 'failing').map((c) => c.name);
	const passing = pr.ciChecks.filter((c) => c.status === 'passing').length;
	if (failing.length > 0) return `failing: ${failing.join(', ')} (+${passing} passing)`;
	return pr.ci === 'pending' ? `pending (${passing} passing)` : `${passing} passing`;
}

function SubTickets({ card }: { card: CardDisplay }): JSX.Element {
	const post = usePost();
	return (
		<div className="detail-section">
			<h3>Sub-tickets</h3>
			{card.subTickets.map((sub) => (
				<div key={sub.key} className="timeline-entry">
					<span className="ticket-key" onClick={() => sub.url && post({ type: 'openExternal', url: sub.url })}>
						{sub.key}
					</span>
					<span>{sub.topic}</span>
					<span className="dim">{sub.status ?? ''}</span>
				</div>
			))}
		</div>
	);
}

function Timeline({ card }: { card: CardDisplay }): JSX.Element {
	return (
		<div className="detail-section">
			<h3>History</h3>
			{[...card.history].reverse().map((entry, i) => (
				<div key={i} className="timeline-entry">
					<span className="when">{entry.at.replace('T', ' ').slice(0, 16)}</span>
					<span className="phase">{entry.phase ?? ''}</span>
					<span>
						{entry.note}
						{entry.runId ? <span className="dim"> · {entry.runId}</span> : null}
					</span>
				</div>
			))}
		</div>
	);
}
