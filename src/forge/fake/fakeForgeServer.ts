/**
 * In-process HTTP server speaking just enough of the GitHub GraphQL and
 * Bitbucket REST dialects for tests (the shamhub pattern). Seeded from
 * FakeRepoData; requests are counted so cache-policy tests can assert
 * "N requests for this scenario". GET responses carry an ETag derived from
 * the body and honor If-None-Match with a 304, so the Bitbucket client's
 * ETag cache is exercised against real HTTP semantics; list endpoints
 * paginate per the `pagelen`/`page` query params like Bitbucket Cloud.
 */

import { createHash } from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';

import { safeParse } from '../../utils/json';
import {
	FakeIssue,
	FakeRepoData,
	renderBitbucketComments,
	renderBitbucketPr,
	renderBitbucketStatuses,
	renderBitbucketTasks,
	renderGithubIssueNode,
	renderGithubIssueState,
	renderGithubPrNode,
	renderRestIssue,
} from './fakeForgeData';

export class FakeForgeServer {
	private readonly server: http.Server;
	private data: FakeRepoData;
	private baseUrl = '';
	requestCount = 0;
	/** GETs answered 304 from the client's If-None-Match. */
	notModifiedCount = 0;
	requestLog: string[] = [];
	/** Issues minted via the create-issue endpoint, in call order. */
	createdIssues: FakeIssue[] = [];

	constructor(data: FakeRepoData) {
		this.data = data;
		this.server = http.createServer((req, res) => this.handle(req, res));
	}

	seed(data: FakeRepoData): void {
		this.data = data;
	}

	async start(): Promise<string> {
		await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
		const address = this.server.address() as AddressInfo;
		this.baseUrl = `http://127.0.0.1:${address.port}`;
		return this.baseUrl;
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		this.requestCount += 1;
		this.requestLog.push(`${req.method} ${req.url}`);
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => this.route(req, res, Buffer.concat(chunks).toString('utf8')));
	}

	private route(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
		const url = req.url ?? '';
		if (req.method === 'POST' && url.endsWith('/graphql')) return this.handleGraphQL(res, body);
		if (req.method === 'POST' && url.endsWith('/issues')) return this.handleCreateIssue(res, body);
		if (url.includes('/pullrequests/')) return this.handleBitbucketPr(req, res, url);
		if (url.split('?')[0].endsWith('/user')) return this.json(req, res, { uuid: `{${this.data.viewerLogin}}` });
		this.json(req, res, { error: 'unknown route' }, 404);
	}

	/** Routes the GraphQL POST to PR-alias, issue-inventory, search, or visibility shapes. */
	private handleGraphQL(res: http.ServerResponse, body: string): void {
		const parsed = (safeParse(body) ?? {}) as { query?: string; variables?: Record<string, unknown> };
		const query = String(parsed?.query ?? '');
		const variables = parsed?.variables ?? {};
		// Route on the query's VARIABLE shape, not a substring of the whole query.
		// The PR-bundle and viewer queries inline everything and send no variables,
		// while each inventory query carries a distinct one ($q search, $labels
		// labeled, $o/$n visibility). Substring-matching the body would silently
		// mis-route a PR request if PR_FIELDS ever gained an `issues(`/`search(`/
		// `visibility` token (closingIssuesReferences only dodges it by casing today).
		if (Object.keys(variables).length === 0) return this.handlePrAliases(res, query);
		if ('q' in variables) return this.handleIssueSearch(res, variables);
		if ('labels' in variables) return this.handleLabeledIssues(res, variables);
		// Visibility and getIssueStates both send only {o,n}; the latter is the one
		// carrying aliased `i<n>: issue(number:…)` lookups, so route on that token.
		if (query.includes('issue(number:')) return this.handleIssueStates(res, query);
		this.handleVisibility(res);
	}

	/** Parses the aliased getIssueStates query: `iN: issue(number: X)`, open AND closed. */
	private handleIssueStates(res: http.ServerResponse, query: string): void {
		if (this.data.repoMissing) return plainJson(res, { data: { repository: null } });
		const repository: Record<string, unknown> = {};
		for (const match of query.matchAll(/(i\d+):\s*issue\(number:\s*(\d+)\)/g)) {
			const issue = (this.data.issues ?? []).find((i) => i.number === Number(match[2]));
			repository[match[1]] = issue ? renderGithubIssueState(issue) : null;
		}
		plainJson(res, { data: { repository } });
	}

	/** Parses the aliased query shape github.ts builds: `prN: pullRequest(number: X)`. */
	private handlePrAliases(res: http.ServerResponse, query: string): void {
		const repository: Record<string, unknown> = {};
		for (const match of query.matchAll(/(pr\d+):\s*pullRequest\(number:\s*(\d+)\)/g)) {
			const pr = this.data.prs.find((p) => p.number === Number(match[2]));
			repository[match[1]] = pr ? renderGithubPrNode(pr, this.data.slug) : null;
		}
		// GraphQL is POST — no ETag semantics, mirroring GitHub.
		plainJson(res, { data: { viewer: { login: this.data.viewerLogin }, repository } });
	}

	private handleVisibility(res: http.ServerResponse): void {
		if (this.data.repoMissing) return plainJson(res, { data: { repository: null } });
		// repoVisibilityAbsent models a present repo whose visibility field is null
		// (the real fail-closed path) — distinct from the fake's 'private' default.
		if (this.data.repoVisibilityAbsent) return plainJson(res, { data: { repository: {} } });
		const visibility = (this.data.visibility ?? 'private').toUpperCase();
		plainJson(res, { data: { repository: { visibility } } });
	}

	private handleLabeledIssues(res: http.ServerResponse, variables: Record<string, unknown>): void {
		if (this.data.repoMissing) return plainJson(res, { data: { repository: null } });
		const labels = asStringArray(variables.labels);
		const nodes = this.openIssues()
			.filter((i) => i.labels.some((l) => labels.includes(l)))
			.map((i) => renderGithubIssueNode(i, this.data.slug));
		plainJson(res, { data: { repository: { issues: { nodes } } } });
	}

	private handleIssueSearch(res: http.ServerResponse, variables: Record<string, unknown>): void {
		// Model GitHub's `in:title "phrase"` fuzzy match: return every open issue
		// whose title CONTAINS the searched phrase (so a `…(v2)` title still comes
		// back), forcing findIssueByTitle's exact-title post-filter to do the work.
		const phrase = quotedPhrase(String(variables.q ?? ''));
		const nodes = this.openIssues()
			.filter((i) => phrase !== null && i.title.includes(phrase))
			.map((i) => renderGithubIssueNode(i, this.data.slug));
		plainJson(res, { data: { search: { nodes } } });
	}

	private handleCreateIssue(res: http.ServerResponse, body: string): void {
		if (this.data.createIssueStatus) {
			return plainJson(res, { message: 'create-issue failed' }, this.data.createIssueStatus);
		}
		const payload = (safeParse(body) ?? {}) as { title?: string; labels?: string[] };
		const issue: FakeIssue = {
			number: this.nextIssueNumber(),
			title: String(payload.title ?? ''),
			state: 'open',
			labels: Array.isArray(payload.labels) ? payload.labels.map(String) : [],
			author: this.data.viewerLogin,
			assignees: [],
		};
		(this.data.issues ??= []).push(issue);
		this.createdIssues.push(issue);
		// Malformed: a 201 whose body omits `number` — the parse guard must reject it.
		const rendered = this.data.createIssueMalformed ? { title: issue.title } : renderRestIssue(issue, this.data.slug);
		plainJson(res, rendered, 201);
	}

	private openIssues(): FakeIssue[] {
		return (this.data.issues ?? []).filter((i) => i.state === 'open');
	}

	private nextIssueNumber(): number {
		const max = (this.data.issues ?? []).reduce((m, i) => Math.max(m, i.number), this.data.prs.length);
		return max + 1;
	}

	private handleBitbucketPr(req: http.IncomingMessage, res: http.ServerResponse, url: string): void {
		const match = url.match(/\/pullrequests\/(\d+)(\/(comments|tasks|statuses))?/);
		const pr = match ? this.data.prs.find((p) => p.number === Number(match[1])) : undefined;
		if (!match || !pr) return this.json(req, res, { error: 'not found' }, 404);
		switch (match[3]) {
			case 'comments':
				return this.paged(req, res, url, renderBitbucketComments(pr));
			case 'tasks':
				return this.paged(req, res, url, renderBitbucketTasks(pr));
			case 'statuses':
				return this.paged(req, res, url, renderBitbucketStatuses(pr));
			default:
				return this.json(req, res, renderBitbucketPr(pr, this.data.slug));
		}
	}

	/** Bitbucket-style pagination: `values` + absolute `next` while more remain. */
	private paged(req: http.IncomingMessage, res: http.ServerResponse, url: string, values: unknown[]): void {
		const params = new URL(url, this.baseUrl || 'http://fake').searchParams;
		const pagelen = Math.max(1, Number(params.get('pagelen') ?? 10));
		const page = Math.max(1, Number(params.get('page') ?? 1));
		const start = (page - 1) * pagelen;
		const payload: Record<string, unknown> = { values: values.slice(start, start + pagelen) };
		if (start + pagelen < values.length) {
			const next = new URL(url, this.baseUrl || 'http://fake');
			next.searchParams.set('page', String(page + 1));
			payload.next = next.toString();
		}
		this.json(req, res, payload);
	}

	/** ETagged JSON: replies 304 when the client's If-None-Match still matches. */
	private json(req: http.IncomingMessage, res: http.ServerResponse, payload: unknown, status = 200): void {
		const body = JSON.stringify(payload);
		const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
		if (status === 200 && req.headers['if-none-match'] === etag) {
			this.notModifiedCount += 1;
			res.writeHead(304, { etag });
			res.end();
			return;
		}
		res.writeHead(status, {
			'content-type': 'application/json',
			'content-length': Buffer.byteLength(body),
			etag,
		});
		res.end(body);
	}
}

function plainJson(res: http.ServerResponse, payload: unknown, status = 200): void {
	const body = JSON.stringify(payload);
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
	res.end(body);
}

function asStringArray(v: unknown): string[] {
	return Array.isArray(v) ? v.map(String) : [];
}

/** The `in:title "phrase"` term githubInventory builds via JSON.stringify(title). */
function quotedPhrase(q: string): string | null {
	const m = q.match(/"(?:\\.|[^"\\])*"/);
	if (!m) return null;
	return safeParse(m[0]) as string | null;
}
