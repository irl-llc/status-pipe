/**
 * PR row derivation: stack indicators from head/base matching across all
 * tracked PRs in a repo, plus the enrichment overlay merge
 * (design/02-protocol.md "Stack relationships", design/05-ui.md card anatomy).
 */

import { ChecksInfo } from '../forge/types';
import { TicketFile, TicketPr } from '../protocol/types';
import { CommentBadge, PrRowDisplay } from './displayTypes';
import { PrEnrichment, RepoEnrichment } from './queueInputs';

/** A label for a tracked PR as it appears in stack indicators: "T1a #855". */
function prLabel(pr: TicketPr): string {
	return pr.part ? `${pr.part} #${pr.number}` : `#${pr.number}`;
}

/** head branch → tracked PR, across every ticket in the repo. */
export function buildHeadIndex(tickets: TicketFile[]): Map<string, TicketPr> {
	const index = new Map<string, TicketPr>();
	for (const pr of tickets.flatMap((t) => t.prs)) {
		if (!index.has(pr.head)) index.set(pr.head, pr);
	}
	return index;
}

function upstreamLabel(pr: TicketPr, headIndex: Map<string, TicketPr>): string {
	const basePr = headIndex.get(pr.base);
	return basePr ? `↑ ${prLabel(basePr)}` : pr.base;
}

function downstreamLabels(pr: TicketPr, allPrs: TicketPr[]): string[] {
	return allPrs.filter((other) => other.base === pr.head && other.number !== pr.number).map(prLabel);
}

function effectiveCi(pr: TicketPr, checks: ChecksInfo | null): PrRowDisplay['ci'] {
	if (checks) return checks.aggregate;
	return pr.ci;
}

function failingCheckUrl(checks: ChecksInfo | null): string | null {
	const failing = checks?.checks.find((c) => c.status === 'failing' && c.url);
	return failing?.url ?? null;
}

function commentBadge(e: PrEnrichment | undefined): CommentBadge | null {
	const c = e?.info?.comments;
	if (!c) return null;
	return {
		unresolved: c.unresolved,
		total: c.total,
		resolvable: c.resolvable,
		prLevelResolvable: c.prLevelResolvable,
		capped: c.capped === true,
	};
}

function reviewBadge(e: PrEnrichment | undefined): PrRowDisplay['reviewDecision'] {
	const d = e?.info?.reviewDecision;
	// review-required is the neutral default — non-default status only.
	return d === 'approved' || d === 'changes-requested' ? d : null;
}

interface PrRowContext {
	headIndex: Map<string, TicketPr>;
	allPrs: TicketPr[];
	enrichment: RepoEnrichment | null;
}

type PrCoreFields = Pick<
	PrRowDisplay,
	'number' | 'url' | 'part' | 'head' | 'state' | 'draft' | 'enriched' | 'deletedOnForge'
>;

function prCore(pr: TicketPr, e: PrEnrichment | undefined): PrCoreFields {
	const info = e?.info ?? null;
	return {
		number: pr.number,
		url: info?.url ?? pr.url,
		part: pr.part,
		head: pr.head,
		state: info?.state ?? pr.state,
		draft: info ? info.draft : pr.draft,
		enriched: info !== null,
		deletedOnForge: e?.deletedOnForge === true,
	};
}

type PrBadgeFields = Pick<
	PrRowDisplay,
	'ci' | 'ciChecks' | 'ciUrl' | 'comments' | 'tasks' | 'reviewDecision' | 'linkedTickets'
>;

function prBadges(pr: TicketPr, e: PrEnrichment | undefined): PrBadgeFields {
	const checks = e?.checks ?? null;
	return {
		ci: effectiveCi(pr, checks),
		ciChecks: (checks?.checks ?? []).map((c) => ({ name: c.name, status: c.status, url: c.url ?? null })),
		ciUrl: failingCheckUrl(checks),
		comments: commentBadge(e),
		tasks: e?.info?.tasks ?? null,
		reviewDecision: reviewBadge(e),
		linkedTickets: (e?.linkedTickets ?? []).map((t) => ({ key: t.key, url: t.url || null })),
	};
}

function buildPrRow(pr: TicketPr, ctx: PrRowContext): PrRowDisplay {
	const e = ctx.enrichment?.prs[pr.number];
	return {
		...prCore(pr, e),
		...prBadges(pr, e),
		upstream: upstreamLabel(pr, ctx.headIndex),
		downstream: downstreamLabels(pr, ctx.allPrs),
	};
}

/** All PR rows for one ticket, open first, then merged/closed (stable). */
export function buildPrRows(
	ticket: TicketFile,
	repoTickets: TicketFile[],
	enrichment: RepoEnrichment | null,
): PrRowDisplay[] {
	const headIndex = buildHeadIndex(repoTickets);
	const allPrs = repoTickets.flatMap((t) => t.prs);
	const ctx: PrRowContext = { headIndex, allPrs, enrichment };
	const rows = ticket.prs.map((pr) => buildPrRow(pr, ctx));
	const openFirst = (r: PrRowDisplay): number => (r.state === 'open' ? 0 : 1);
	return rows.sort((a, b) => openFirst(a) - openFirst(b) || a.number - b.number);
}
