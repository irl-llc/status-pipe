/**
 * Seed data for the fake forge (design/03-forge.md "Testing", the shamhub
 * pattern). One high-level PR shape is rendered into both the GitHub
 * GraphQL and Bitbucket REST dialects, so tests exercise the real mapping
 * layers against deterministic data.
 */

import { CheckStatus } from '../types';

export interface FakeThread {
	resolved: boolean;
	comments: number;
}

export interface FakeCheck {
	name: string;
	status: CheckStatus;
	url?: string;
}

export interface FakePr {
	number: number;
	title: string;
	state: 'open' | 'merged' | 'closed';
	draft: boolean;
	head: string;
	base: string;
	updatedAt: string;
	/** PR-level (non-inline) conversation comments. */
	prLevelComments: number;
	threads: FakeThread[];
	reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
	reviewRequests: string[];
	checks: FakeCheck[];
	linkedTickets: Array<{ key: string; title: string }>;
	/** Bitbucket-only concept. */
	tasks?: { total: number; unresolved: number };
}

export interface FakeIssue {
	number: number;
	title: string;
	state: 'open' | 'closed';
	labels: string[];
	author: string | null;
	assignees: string[];
	url?: string;
}

export interface FakeRepoData {
	slug: string;
	viewerLogin: string;
	prs: FakePr[];
	/** Repo visibility for the inventory trust gate; defaults to private. */
	visibility?: 'public' | 'private' | 'internal';
	/** Open/closed issues for the inventory queries; defaults to none. */
	issues?: FakeIssue[];
	/** When set, repository-scoped GraphQL resolves `repository: null` (bad
	 * creds / typo / deleted repo) so not-found handling can be exercised. */
	repoMissing?: boolean;
	/** When set, the repo is present but its `visibility` field is null, to
	 * exercise the fail-closed (→ 'public') mapping for an unknown visibility. */
	repoVisibilityAbsent?: boolean;
	/** When set, the create-issue endpoint replies with this HTTP status (instead
	 * of 201) so createLabeledIssue's statusToForgeError mapping can be exercised. */
	createIssueStatus?: number;
	/** When set, the create-issue endpoint returns 201 with a body lacking
	 * `number`, exercising the malformed-response guard in parseCreatedIssue. */
	createIssueMalformed?: boolean;
}

/** GraphQL Issue node shape (`issues { nodes }` and `search { nodes }`). */
export function renderGithubIssueNode(issue: FakeIssue, slug: string): Record<string, unknown> {
	return {
		number: issue.number,
		title: issue.title,
		url: issue.url ?? `https://github.com/${slug}/issues/${issue.number}`,
		author: issue.author === null ? null : { login: issue.author },
		assignees: { nodes: issue.assignees.map((login) => ({ login })) },
	};
}

/** REST issue shape (the create-issue response). */
export function renderRestIssue(issue: FakeIssue, slug: string): Record<string, unknown> {
	return {
		number: issue.number,
		title: issue.title,
		html_url: issue.url ?? `https://github.com/${slug}/issues/${issue.number}`,
		user: issue.author === null ? null : { login: issue.author },
		assignees: issue.assignees.map((login) => ({ login })),
	};
}

function githubThreadNodes(pr: FakePr): Record<string, unknown> {
	return {
		totalCount: pr.threads.length,
		nodes: pr.threads.map((t) => ({ isResolved: t.resolved, comments: { totalCount: t.comments } })),
	};
}

function githubClosingRefs(pr: FakePr, slug: string): Record<string, unknown> {
	return {
		nodes: pr.linkedTickets.map((t) => ({
			number: Number(t.key) || 0,
			title: t.title,
			url: `https://github.com/${slug}/issues/${t.key}`,
		})),
	};
}

function githubRollup(pr: FakePr): Record<string, unknown> | null {
	if (pr.checks.length === 0) return null;
	return {
		state: githubRollupState(pr.checks),
		contexts: {
			nodes: pr.checks.map((c) => ({
				name: c.name,
				status: c.status === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
				conclusion: githubConclusion(c.status),
				detailsUrl: c.url ?? null,
			})),
		},
	};
}

export function renderGithubPrNode(pr: FakePr, slug: string): Record<string, unknown> {
	return {
		number: pr.number,
		url: `https://github.com/${slug}/pull/${pr.number}`,
		state: pr.state.toUpperCase(),
		isDraft: pr.draft,
		title: pr.title,
		headRefName: pr.head,
		baseRefName: pr.base,
		updatedAt: pr.updatedAt,
		comments: { totalCount: pr.prLevelComments },
		reviewThreads: githubThreadNodes(pr),
		reviewDecision: pr.reviewDecision,
		reviewRequests: { nodes: pr.reviewRequests.map((login) => ({ requestedReviewer: { login } })) },
		closingIssuesReferences: githubClosingRefs(pr, slug),
		commits: { nodes: [{ commit: { statusCheckRollup: githubRollup(pr) } }] },
	};
}

function githubRollupState(checks: FakeCheck[]): string {
	if (checks.some((c) => c.status === 'failing')) return 'FAILURE';
	if (checks.some((c) => c.status === 'pending')) return 'PENDING';
	return 'SUCCESS';
}

function githubConclusion(status: CheckStatus): string | null {
	switch (status) {
		case 'passing':
			return 'SUCCESS';
		case 'failing':
			return 'FAILURE';
		case 'skipped':
			return 'SKIPPED';
		default:
			return null;
	}
}

export function renderBitbucketPr(pr: FakePr, slug: string): Record<string, unknown> {
	return {
		id: pr.number,
		title: pr.title,
		state: pr.state === 'merged' ? 'MERGED' : pr.state === 'closed' ? 'DECLINED' : 'OPEN',
		draft: pr.draft,
		links: { html: { href: `https://bitbucket.org/${slug}/pull-requests/${pr.number}` } },
		source: { branch: { name: pr.head } },
		destination: { branch: { name: pr.base } },
		updated_on: pr.updatedAt,
		participants:
			pr.reviewDecision === null
				? []
				: [{ state: pr.reviewDecision === 'APPROVED' ? 'approved' : 'changes_requested' }],
		reviewers: pr.reviewRequests.map((id) => ({ uuid: id })),
		summary: { raw: pr.linkedTickets.map((t) => t.key).join(' ') },
	};
}

export function renderBitbucketComments(pr: FakePr): Array<Record<string, unknown>> {
	const inline = pr.threads.flatMap((t, i) =>
		Array.from({ length: t.comments }, (_, j) => ({
			id: i * 100 + j,
			deleted: false,
			inline: { path: 'file.ts' },
			resolution: t.resolved ? { type: 'resolved' } : null,
		})),
	);
	const prLevel = Array.from({ length: pr.prLevelComments }, (_, i) => ({ id: 10_000 + i, deleted: false }));
	return [...inline, ...prLevel];
}

export function renderBitbucketTasks(pr: FakePr): Array<Record<string, unknown>> {
	const tasks = pr.tasks ?? { total: 0, unresolved: 0 };
	return Array.from({ length: tasks.total }, (_, i) => ({
		id: i,
		state: i < tasks.unresolved ? 'UNRESOLVED' : 'RESOLVED',
	}));
}

export function renderBitbucketStatuses(pr: FakePr): Array<Record<string, unknown>> {
	return pr.checks.map((c) => ({
		key: c.name,
		name: c.name,
		state: c.status === 'passing' ? 'SUCCESSFUL' : c.status === 'failing' ? 'FAILED' : 'INPROGRESS',
		url: c.url ?? null,
	}));
}
