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

import {
	FakeRepoData,
	renderBitbucketComments,
	renderBitbucketPr,
	renderBitbucketStatuses,
	renderBitbucketTasks,
	renderGithubPrNode,
} from './fakeForgeData';

export class FakeForgeServer {
	private readonly server: http.Server;
	private data: FakeRepoData;
	private baseUrl = '';
	requestCount = 0;
	/** GETs answered 304 from the client's If-None-Match. */
	notModifiedCount = 0;
	requestLog: string[] = [];

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
		if (url.includes('/pullrequests/')) return this.handleBitbucketPr(req, res, url);
		if (url.split('?')[0].endsWith('/user')) return this.json(req, res, { uuid: `{${this.data.viewerLogin}}` });
		this.json(req, res, { error: 'unknown route' }, 404);
	}

	/** Parses the aliased query shape github.ts builds: `prN: pullRequest(number: X)`. */
	private handleGraphQL(res: http.ServerResponse, body: string): void {
		const query = String(JSON.parse(body)?.query ?? '');
		const repository: Record<string, unknown> = {};
		for (const match of query.matchAll(/(pr\d+):\s*pullRequest\(number:\s*(\d+)\)/g)) {
			const pr = this.data.prs.find((p) => p.number === Number(match[2]));
			repository[match[1]] = pr ? renderGithubPrNode(pr, this.data.slug) : null;
		}
		// GraphQL is POST — no ETag semantics, mirroring GitHub.
		plainJson(res, { data: { viewer: { login: this.data.viewerLogin }, repository } });
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

function plainJson(res: http.ServerResponse, payload: unknown): void {
	const body = JSON.stringify(payload);
	res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
	res.end(body);
}
