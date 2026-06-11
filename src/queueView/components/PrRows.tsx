/**
 * PR rows with stack indicators and non-default-only badges
 * (design/05-ui.md card anatomy): a healthy PR row is just
 * `#512 T1a rate-limit-core`; detail lives on hover.
 */

import { useState, type JSX } from 'react';

import { CardDisplay, PrRowDisplay } from '../../queue/displayTypes';
import { cappedCount } from '../format';
import { usePost } from './QueueApp';

export function PrRows({ card }: { card: CardDisplay }): JSX.Element | null {
	const [showMerged, setShowMerged] = useState(false);
	const open = card.prs.filter((pr) => pr.state === 'open');
	const closed = card.prs.filter((pr) => pr.state !== 'open');
	if (card.prs.length === 0) return null;
	return (
		<div onClick={(e) => e.stopPropagation()}>
			{open.map((pr) => (
				<PrBlock key={pr.number} pr={pr} card={card} />
			))}
			{closed.length > 0 && !showMerged && (
				<div className="merged-collapse" onClick={() => setShowMerged(true)}>
					{closed.length} merged
				</div>
			)}
			{showMerged && closed.map((pr) => <PrBlock key={pr.number} pr={pr} card={card} dim />)}
		</div>
	);
}

function PrBlock({ pr, card, dim }: { pr: PrRowDisplay; card: CardDisplay; dim?: boolean }): JSX.Element {
	const post = usePost();
	const openPr = (): void => {
		if (pr.url) post({ type: 'openExternal', url: pr.url });
	};
	return (
		<div className={`pr-block${dim ? ' dim' : ''}`}>
			<div className="stack-ref">↑ {pr.upstream}</div>
			<div className="pr-row">
				<span className="pr-number" onClick={openPr} title={pr.deletedOnForge ? 'deleted on forge' : (pr.url ?? '')}>
					#{pr.number}
				</span>
				{pr.part && <span className="pr-part">{pr.part}</span>}
				<span className="pr-head">{pr.head}</span>
				<Badges pr={pr} card={card} />
			</div>
			{pr.downstream.length > 0 && <div className="stack-ref">↓ {pr.downstream.join(', ')}</div>}
		</div>
	);
}

/** Non-default badges only — a green PR row carries none. */
function Badges({ pr, card }: { pr: PrRowDisplay; card: CardDisplay }): JSX.Element {
	const post = usePost();
	return (
		<>
			{pr.draft && (
				<span className="pr-badge" title="draft">
					<span className="codicon codicon-git-pull-request-draft" />
				</span>
			)}
			{pr.ci === 'failing' && (
				<span
					className="pr-badge ci-failing"
					title={ciTooltip(pr)}
					onClick={() => pr.ciUrl && post({ type: 'openExternal', url: pr.ciUrl })}
				>
					<span className="codicon codicon-x" />
				</span>
			)}
			{pr.ci === 'pending' && (
				<span className="pr-badge ci-pending" title={ciTooltip(pr)}>
					<span className="codicon codicon-clock" />
				</span>
			)}
			{pr.comments && pr.comments.unresolved > 0 && (
				<span className="pr-badge" title={commentsTooltip(pr)}>
					<span className="codicon codicon-comment-discussion" />
					{cappedCount(pr.comments.unresolved, pr.comments.capped)}/{pr.comments.total}
				</span>
			)}
			{pr.tasks && pr.tasks.unresolved > 0 && (
				<span className="pr-badge" title={`${pr.tasks.unresolved} of ${pr.tasks.total} tasks open`}>
					<span className="codicon codicon-checklist" />
					{pr.tasks.unresolved}/{pr.tasks.total}
				</span>
			)}
			{pr.reviewDecision === 'changes-requested' && (
				<span className="pr-badge changes-requested" title="changes requested">
					<span className="codicon codicon-request-changes" />
				</span>
			)}
			{pr.reviewDecision === 'approved' && (
				<span className="pr-badge" title="approved">
					<span className="codicon codicon-check" />
				</span>
			)}
			{pr.linkedTickets
				.filter((t) => t.key !== card.ticket)
				.map((t) => (
					<span
						key={t.key}
						className="pr-badge"
						title={t.url ?? t.key}
						onClick={() => t.url && post({ type: 'openExternal', url: t.url })}
					>
						<span className="codicon codicon-link" />
						{t.key}
					</span>
				))}
		</>
	);
}

function ciTooltip(pr: PrRowDisplay): string {
	if (pr.ciChecks.length === 0) return `CI ${pr.ci}`;
	return pr.ciChecks
		.map((c) => `${c.status === 'passing' ? '✓' : c.status === 'failing' ? '✗' : '…'} ${c.name}`)
		.join('\n');
}

function commentsTooltip(pr: PrRowDisplay): string {
	const c = pr.comments!;
	const resolvable = `${cappedCount(c.resolvable, c.capped)} of ${c.total} resolvable`;
	const prLevel = c.prLevelResolvable ? '' : ' (PR-level comments are not resolvable on this forge)';
	return `${c.unresolved} unresolved · ${resolvable}${prLevel}`;
}
