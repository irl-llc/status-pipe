/**
 * Bitbucket Cloud forge (design/03-forge.md): REST 2.0, N+1 per PR by
 * nature, so every GET sends If-None-Match (ETag cache) and rides a 4-way
 * concurrency pool.
 */

import { Json, asArr, asObj, asStr } from '../utils/json';
import { HttpClient, HttpResponse, RateListener, RequestPool, statusToForgeError } from './http';
import {
	mapBitbucketComments,
	mapBitbucketPr,
	mapBitbucketStatuses,
	mapBitbucketTasks,
	parseJiraKeys,
} from './bitbucketMapping';
import { hostMatches, hostOf, parseRemote } from './remote';
import {
	ChecksInfo,
	Forge,
	ForgeAuth,
	ForgeCapabilities,
	ForgeError,
	ForgeRepository,
	PullRequestInfo,
	RepositoryId,
	TicketRef,
} from './types';

const CAPABILITIES: ForgeCapabilities = { tasks: true, threadResolution: true, ticketLinks: 'key-parsed' };

export interface BitbucketForgeOptions {
	baseUrl?: string;
	apiUrl?: string;
	http: HttpClient;
	onRateInfo?: RateListener;
	/** From repo config.json / settings; enables Jira browse URLs on parsed keys. */
	jiraSiteUrl?: string | null;
}

export class BitbucketForge implements Forge {
	readonly id = 'bitbucket';
	readonly baseUrl: string;
	readonly capabilities = CAPABILITIES;
	private readonly apiUrl: string;

	constructor(private readonly options: BitbucketForgeOptions) {
		this.baseUrl = options.baseUrl ?? 'https://bitbucket.org';
		this.apiUrl = options.apiUrl ?? 'https://api.bitbucket.org/2.0';
	}

	matchRemoteUrl(remoteUrl: string): RepositoryId | null {
		const remote = parseRemote(remoteUrl);
		if (!remote || !hostMatches(remote.host, hostOf(this.baseUrl))) return null;
		return this.repositoryId(remote.slug);
	}

	repositoryId(slug: string): RepositoryId {
		const baseUrl = this.baseUrl;
		return {
			forgeId: this.id,
			slug,
			prUrl: (n: number) => `${baseUrl}/${slug}/pull-requests/${n}`,
		};
	}

	openRepository(id: RepositoryId, auth: ForgeAuth): ForgeRepository {
		return new BitbucketRepository(this, id, { auth, apiUrl: this.apiUrl, options: this.options });
	}
}

interface BitbucketRepoConfig {
	auth: ForgeAuth;
	apiUrl: string;
	options: BitbucketForgeOptions;
}

interface EtagEntry {
	etag: string;
	body: string;
}

class BitbucketRepository implements ForgeRepository {
	private readonly pool = new RequestPool(4);
	private readonly etags = new Map<string, EtagEntry>();
	private readonly prJson = new Map<number, Json>();
	private viewerId: string | null = null;

	constructor(
		readonly forge: BitbucketForge,
		readonly id: RepositoryId,
		private readonly config: BitbucketRepoConfig,
	) {}

	async getPullRequests(numbers: number[]): Promise<PullRequestInfo[]> {
		const results = await Promise.all(numbers.map((n) => this.fetchPr(n)));
		return results.filter((r): r is PullRequestInfo => r !== null);
	}

	private async fetchPr(number: number): Promise<PullRequestInfo | null> {
		const pr = await this.getJson(this.prPath(number, ''));
		if (!pr) return null;
		this.prJson.set(number, pr);
		const info = mapBitbucketPr(pr);
		if (!info) return null;
		const [comments, tasks] = await Promise.all([
			this.getPaged(this.prPath(number, '/comments')),
			this.getPaged(this.prPath(number, '/tasks')),
		]);
		info.comments = mapBitbucketComments(comments);
		info.tasks = mapBitbucketTasks(tasks);
		return info;
	}

	async getChecks(prNumber: number): Promise<ChecksInfo> {
		const statuses = await this.getPaged(this.prPath(prNumber, '/statuses'));
		return mapBitbucketStatuses(statuses);
	}

	async getLinkedTickets(prNumber: number): Promise<TicketRef[]> {
		const pr = this.prJson.get(prNumber) ?? (await this.getJson(this.prPath(prNumber, '')));
		if (!pr) return [];
		return parseJiraKeys(pr, this.config.options.jiraSiteUrl ?? null);
	}

	async getViewerLogin(): Promise<string | null> {
		if (this.viewerId === null) {
			const user = await this.getJson(`${this.config.apiUrl}/user`);
			this.viewerId = user ? asStr(user.uuid) : null;
		}
		return this.viewerId;
	}

	private prPath(number: number, suffix: string): string {
		return `${this.config.apiUrl}/repositories/${this.id.slug}/pullrequests/${number}${suffix}`;
	}

	private async getPaged(url: string): Promise<unknown[]> {
		const values: unknown[] = [];
		let next: string | null = `${url}${url.includes('?') ? '&' : '?'}pagelen=100`;
		while (next) {
			const page: Json | null = await this.getJson(next);
			if (!page) break;
			values.push(...asArr(page.values));
			next = asStr(page.next);
		}
		return values;
	}

	private async getJson(url: string): Promise<Json | null> {
		const response = await this.pool.run(() => this.config.options.http(this.buildRequest(url)));
		if (response.status === 304) return this.cachedBody(url);
		if (response.status === 404) return null; // deleted on forge — row detail, not a failure
		const error = statusToForgeError(response);
		if (error) throw error;
		this.storeEtag(url, response);
		const parsed = asObj(safeParse(response.body));
		if (!parsed) throw new ForgeError('network', 'malformed Bitbucket response');
		return parsed;
	}

	private buildRequest(url: string): Parameters<HttpClient>[0] {
		const headers: Record<string, string> = {
			authorization: this.authHeader(),
			accept: 'application/json',
			'user-agent': 'status-pipe',
		};
		const cached = this.etags.get(url);
		if (cached) headers['if-none-match'] = cached.etag;
		return { url, method: 'GET', headers };
	}

	private authHeader(): string {
		if (this.config.auth.username) {
			return `Basic ${Buffer.from(`${this.config.auth.username}:${this.config.auth.token}`).toString('base64')}`;
		}
		return `Bearer ${this.config.auth.token}`;
	}

	private storeEtag(url: string, response: HttpResponse): void {
		const etag = response.header('etag');
		if (etag) this.etags.set(url, { etag, body: response.body });
	}

	private cachedBody(url: string): Json | null {
		const cached = this.etags.get(url);
		return cached ? asObj(safeParse(cached.body)) : null;
	}
}

function safeParse(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}
