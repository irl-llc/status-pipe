/**
 * Pure mapping: Bitbucket Cloud REST 2.0 responses → forge types
 * (design/03-forge.md, Bitbucket section). Spike note: per-comment
 * `resolution` flags are under-documented — when absent everywhere the
 * mapping degrades to resolvable: 0 and the UI captions accordingly.
 */

import { Json, asArr, asBool, asNum, asObj, asStr, dig } from '../utils/json';
import {
	ChecksInfo,
	CheckStatus,
	CommentCounts,
	PullRequestInfo,
	ReviewDecision,
	TaskCounts,
	TicketRef,
} from './types';

function mapBitbucketPrState(v: unknown): PullRequestInfo['state'] {
	switch (asStr(v)) {
		case 'MERGED':
			return 'merged';
		case 'DECLINED':
		case 'SUPERSEDED':
			return 'closed';
		default:
			return 'open';
	}
}

function mapParticipantsDecision(pr: Json): ReviewDecision {
	const participants = asArr(pr.participants).map(asObj);
	if (participants.some((p) => asStr(p?.state) === 'changes_requested')) return 'changes-requested';
	if (participants.some((p) => asStr(p?.state) === 'approved')) return 'approved';
	return null;
}

function mapReviewerIds(pr: Json): string[] {
	return asArr(pr.reviewers)
		.map((r) => asStr(dig(r, 'uuid')))
		.filter((id): id is string => id !== null);
}

export function mapBitbucketPr(pr: Json): PullRequestInfo | null {
	const number = asNum(pr.id);
	if (number === null) return null;
	return {
		number,
		url: asStr(dig(pr, 'links', 'html', 'href')) ?? '',
		state: mapBitbucketPrState(pr.state),
		draft: asBool(pr.draft),
		title: asStr(pr.title) ?? '',
		headBranch: asStr(dig(pr, 'source', 'branch', 'name')) ?? '',
		baseBranch: asStr(dig(pr, 'destination', 'branch', 'name')) ?? '',
		comments: { total: 0, resolvable: 0, unresolved: 0, prLevelResolvable: false },
		reviewDecision: mapParticipantsDecision(pr),
		reviewRequests: mapReviewerIds(pr),
		updatedAt: asStr(pr.updated_on) ?? '',
	};
}

/**
 * Inline comments carry resolution; PR-level comments don't — the
 * "3 of 7 resolvable" captioning case.
 */
export function mapBitbucketComments(commentValues: unknown[]): CommentCounts {
	const comments = commentValues.map(asObj).filter((c): c is Json => c !== null && !asBool(c.deleted));
	const inline = comments.filter((c) => asObj(c.inline) !== null);
	const unresolved = inline.filter((c) => !isResolved(c)).length;
	return { total: comments.length, resolvable: inline.length, unresolved, prLevelResolvable: false };
}

function isResolved(comment: Json): boolean {
	// Bitbucket marks resolution either as a `resolution` object or a
	// `resolved` boolean depending on API era; accept both.
	return asObj(comment.resolution) !== null || asBool(comment.resolved);
}

export function mapBitbucketTasks(taskValues: unknown[]): TaskCounts {
	const tasks = taskValues.map(asObj).filter((t): t is Json => t !== null);
	const unresolved = tasks.filter((t) => asStr(t.state) !== 'RESOLVED').length;
	return { total: tasks.length, unresolved };
}

function mapStatusState(v: unknown): CheckStatus {
	switch (asStr(v)) {
		case 'SUCCESSFUL':
			return 'passing';
		case 'FAILED':
		case 'STOPPED':
			return 'failing';
		default:
			return 'pending';
	}
}

/** Aggregation mirrors git-spice's bitbucket aggregateStatuses. */
export function mapBitbucketStatuses(statusValues: unknown[]): ChecksInfo {
	const statuses = statusValues.map(asObj).filter((s): s is Json => s !== null);
	const checks = statuses.map((s) => ({
		name: asStr(s.name) ?? asStr(s.key) ?? 'build',
		status: mapStatusState(s.state),
		url: asStr(s.url) ?? undefined,
	}));
	return { aggregate: aggregateStatuses(checks), checks };
}

function aggregateStatuses(checks: ChecksInfo['checks']): ChecksInfo['aggregate'] {
	if (checks.length === 0) return 'none';
	if (checks.some((c) => c.status === 'failing')) return 'failing';
	if (checks.some((c) => c.status === 'pending')) return 'pending';
	return 'passing';
}

const JIRA_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;

/**
 * Jira keys parsed from branch name / title / description — the same
 * convention Bitbucket's own Jira integration uses (capability:
 * 'key-parsed'). Without a Jira site URL the refs degrade to plain keys.
 */
export function parseJiraKeys(pr: Json, jiraSiteUrl: string | null): TicketRef[] {
	const haystack = [
		asStr(dig(pr, 'source', 'branch', 'name')) ?? '',
		asStr(pr.title) ?? '',
		asStr(pr.summary && asObj(pr.summary)?.raw) ?? asStr(pr.description) ?? '',
	].join('\n');
	const keys = [...new Set(haystack.match(JIRA_KEY) ?? [])];
	return keys.map((key) => ({ key, url: jiraSiteUrl ? `${jiraSiteUrl.replace(/\/$/, '')}/browse/${key}` : '' }));
}
