/**
 * Pure mapping: GitHub GraphQL response nodes → forge types
 * (design/03-forge.md, GitHub section). Unit-tested against recorded
 * response fixtures; everything is defensive — the API shape is not ours.
 */

import { asArr, asBool, asNum, asObj, asStr, dig, Json } from '../utils/json';
import { ChecksInfo, CheckStatus, CommentCounts, PullRequestInfo, ReviewDecision, TicketRef } from './types';

const THREAD_CAP = 100;

export function mapGithubComments(node: Json): CommentCounts {
	const prLevel = asNum(dig(node, 'comments', 'totalCount')) ?? 0;
	const threadsTotal = asNum(dig(node, 'reviewThreads', 'totalCount')) ?? 0;
	const threads = asArr(dig(node, 'reviewThreads', 'nodes')).map(asObj);
	const inline = threads.reduce((sum, t) => sum + (asNum(dig(t, 'comments', 'totalCount')) ?? 0), 0);
	const unresolved = threads.filter((t) => t !== null && !asBool(t.isResolved)).length;
	return {
		total: prLevel + inline,
		resolvable: threadsTotal,
		unresolved,
		prLevelResolvable: false,
		capped: threadsTotal > THREAD_CAP,
	};
}

function mapReviewDecision(v: unknown): ReviewDecision {
	switch (asStr(v)) {
		case 'APPROVED':
			return 'approved';
		case 'CHANGES_REQUESTED':
			return 'changes-requested';
		case 'REVIEW_REQUIRED':
			return 'review-required';
		default:
			return null;
	}
}

function mapReviewRequests(node: Json): string[] {
	return asArr(dig(node, 'reviewRequests', 'nodes'))
		.map((n) => asStr(dig(n, 'requestedReviewer', 'login')) ?? asStr(dig(n, 'requestedReviewer', 'slug')))
		.filter((login): login is string => login !== null);
}

function mapPrState(v: unknown): PullRequestInfo['state'] {
	const s = asStr(v);
	return s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : 'open';
}

export function mapGithubPr(node: Json): PullRequestInfo | null {
	const number = asNum(node.number);
	if (number === null) return null;
	return {
		number,
		url: asStr(node.url) ?? '',
		state: mapPrState(node.state),
		draft: asBool(node.isDraft),
		title: asStr(node.title) ?? '',
		headBranch: asStr(node.headRefName) ?? '',
		baseBranch: asStr(node.baseRefName) ?? '',
		comments: mapGithubComments(node),
		reviewDecision: mapReviewDecision(node.reviewDecision),
		reviewRequests: mapReviewRequests(node),
		updatedAt: asStr(node.updatedAt) ?? '',
	};
}

function mapRollupState(v: unknown): ChecksInfo['aggregate'] {
	switch (asStr(v)) {
		case 'SUCCESS':
			return 'passing';
		case 'FAILURE':
		case 'ERROR':
			return 'failing';
		case 'PENDING':
		case 'EXPECTED':
			return 'pending';
		default:
			return 'none';
	}
}

function mapCheckRunStatus(node: Json): CheckStatus {
	if (asStr(node.status) !== 'COMPLETED') return 'pending';
	switch (asStr(node.conclusion)) {
		case 'SUCCESS':
			return 'passing';
		case 'SKIPPED':
		case 'NEUTRAL':
			return 'skipped';
		default:
			return 'failing';
	}
}

function mapStatusContextState(v: unknown): CheckStatus {
	switch (asStr(v)) {
		case 'SUCCESS':
			return 'passing';
		case 'PENDING':
			return 'pending';
		default:
			return 'failing';
	}
}

function mapCheckNode(node: Json): ChecksInfo['checks'][number] | null {
	const checkRunName = asStr(node.name);
	if (checkRunName !== null) {
		return { name: checkRunName, status: mapCheckRunStatus(node), url: asStr(node.detailsUrl) ?? undefined };
	}
	const contextName = asStr(node.context);
	if (contextName !== null) {
		return { name: contextName, status: mapStatusContextState(node.state), url: asStr(node.targetUrl) ?? undefined };
	}
	return null;
}

export function mapGithubChecks(node: Json): ChecksInfo {
	const rollup = dig(node, 'commits', 'nodes');
	const first = asObj(asArr(rollup)[0]);
	const rollupNode = dig(first, 'commit', 'statusCheckRollup');
	if (!asObj(rollupNode)) return { aggregate: 'none', checks: [] };
	const checks = asArr(dig(rollupNode, 'contexts', 'nodes'))
		.map(asObj)
		.map((n) => (n ? mapCheckNode(n) : null))
		.filter((c): c is ChecksInfo['checks'][number] => c !== null);
	return { aggregate: mapRollupState(asObj(rollupNode)?.state), checks };
}

export function mapGithubLinkedTickets(node: Json): TicketRef[] {
	return asArr(dig(node, 'closingIssuesReferences', 'nodes'))
		.map(asObj)
		.flatMap((n) => {
			const number = n ? asNum(n.number) : null;
			if (number === null) return [];
			return [{ key: String(number), title: asStr(n!.title) ?? undefined, url: asStr(n!.url) ?? '' }];
		});
}
