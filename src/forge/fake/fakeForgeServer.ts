/**
 * In-process HTTP server speaking just enough of the GitHub GraphQL and
 * Bitbucket REST dialects for e2e tests (the shamhub pattern). Seeded from
 * FakeRepoData; requests are counted so cache-policy tests can assert
 * "N requests for this scenario".
 */

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
	requestCount = 0;
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
		return `http://127.0.0.1:${address.port}`;
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
		if (url.includes('/pullrequests/')) return this.handleBitbucketPr(res, url);
		if (url.endsWith('/user')) return json(res, { uuid: `{${this.data.viewerLogin}}` });
		json(res, { error: 'unknown route' }, 404);
	}

	/** Parses the aliased query shape github.ts builds: `prN: pullRequest(number: X)`. */
	private handleGraphQL(res: http.ServerResponse, body: string): void {
		const query = String(JSON.parse(body)?.query ?? '');
		const repository: Record<string, unknown> = {};
		for (const match of query.matchAll(/(pr\d+):\s*pullRequest\(number:\s*(\d+)\)/g)) {
			const pr = this.data.prs.find((p) => p.number === Number(match[2]));
			repository[match[1]] = pr ? renderGithubPrNode(pr, this.data.slug) : null;
		}
		json(res, { data: { viewer: { login: this.data.viewerLogin }, repository } });
	}

	private handleBitbucketPr(res: http.ServerResponse, url: string): void {
		const match = url.match(/\/pullrequests\/(\d+)(\/(comments|tasks|statuses))?/);
		const pr = match ? this.data.prs.find((p) => p.number === Number(match[1])) : undefined;
		if (!match || !pr) return json(res, { error: 'not found' }, 404);
		switch (match[3]) {
			case 'comments':
				return json(res, { values: renderBitbucketComments(pr) });
			case 'tasks':
				return json(res, { values: renderBitbucketTasks(pr) });
			case 'statuses':
				return json(res, { values: renderBitbucketStatuses(pr) });
			default:
				return json(res, renderBitbucketPr(pr, this.data.slug));
		}
	}
}

function json(res: http.ServerResponse, payload: unknown, status = 200): void {
	const body = JSON.stringify(payload);
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
	res.end(body);
}
