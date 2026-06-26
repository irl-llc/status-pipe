/**
 * GitHub forge (design/03-forge.md): one aliased GraphQL query per repo per
 * refresh covering every tracked PR — metadata, threads, checks, linked
 * tickets, viewer — so cost scales with refreshes, not PR count.
 */

import { Json, asObj, asStr, dig } from '../utils/json';
import { executeGraphQL } from './graphql';
import { GithubInventory } from './githubInventory';
import { HttpClient, RateListener } from './http';
import { mapGithubChecks, mapGithubLinkedTickets, mapGithubPr } from './githubMapping';
import { hostMatches, hostOf, parseRemote } from './remote';
import {
	ChecksInfo,
	Forge,
	ForgeAuth,
	ForgeCapabilities,
	ForgeError,
	ForgeInventory,
	ForgeRepository,
	PullRequestInfo,
	RepositoryId,
	TicketRef,
} from './types';

const CAPABILITIES: ForgeCapabilities = { tasks: false, threadResolution: true, ticketLinks: 'native' };

export interface GithubForgeOptions {
	baseUrl?: string;
	apiUrl?: string;
	http: HttpClient;
	onRateInfo?: RateListener;
}

const PR_FIELDS = `
	number url state isDraft title headRefName baseRefName updatedAt
	comments { totalCount }
	reviewThreads(first: 100) { totalCount nodes { isResolved comments { totalCount } } }
	reviewDecision
	reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
	closingIssuesReferences(first: 10) { nodes { number title url } }
	commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes {
		... on CheckRun { name status conclusion detailsUrl }
		... on StatusContext { context state targetUrl }
	} } } } } }`;

export class GithubForge implements Forge {
	readonly id = 'github';
	readonly baseUrl: string;
	readonly capabilities = CAPABILITIES;
	private readonly apiUrl: string;

	constructor(private readonly options: GithubForgeOptions) {
		this.baseUrl = options.baseUrl ?? 'https://github.com';
		this.apiUrl = options.apiUrl ?? 'https://api.github.com';
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
			prUrl: (n: number) => `${baseUrl}/${slug}/pull/${n}`,
		};
	}

	openRepository(id: RepositoryId, auth: ForgeAuth): ForgeRepository {
		return new GithubRepository(this, id, { auth, apiUrl: this.apiUrl, options: this.options });
	}

	openInventory(id: RepositoryId, auth: ForgeAuth): ForgeInventory {
		return new GithubInventory({
			apiUrl: this.apiUrl,
			slug: id.slug,
			token: auth.token,
			http: this.options.http,
			onRateInfo: this.options.onRateInfo,
		});
	}
}

interface GithubRepoConfig {
	auth: ForgeAuth;
	apiUrl: string;
	options: GithubForgeOptions;
}

interface PrBundle {
	info: PullRequestInfo;
	checks: ChecksInfo;
	linkedTickets: TicketRef[];
}

class GithubRepository implements ForgeRepository {
	private readonly bundles = new Map<number, PrBundle>();
	private viewerLogin: string | null = null;

	constructor(
		readonly forge: GithubForge,
		readonly id: RepositoryId,
		private readonly config: GithubRepoConfig,
	) {}

	async getPullRequests(numbers: number[]): Promise<PullRequestInfo[]> {
		if (numbers.length === 0) return [];
		const data = await this.executeGraphQL(this.buildQuery(numbers));
		this.ingest(data, numbers);
		return numbers.flatMap((n) => {
			const bundle = this.bundles.get(n);
			return bundle ? [bundle.info] : [];
		});
	}

	async getChecks(prNumber: number): Promise<ChecksInfo> {
		const bundle = await this.bundleFor(prNumber);
		return bundle?.checks ?? { aggregate: 'none', checks: [] };
	}

	async getLinkedTickets(prNumber: number): Promise<TicketRef[]> {
		const bundle = await this.bundleFor(prNumber);
		return bundle?.linkedTickets ?? [];
	}

	async getViewerLogin(): Promise<string | null> {
		if (this.viewerLogin === null) {
			const data = await this.executeGraphQL('query { viewer { login } }');
			this.viewerLogin = asStr(dig(data, 'viewer', 'login'));
		}
		return this.viewerLogin;
	}

	private async bundleFor(prNumber: number): Promise<PrBundle | null> {
		if (!this.bundles.has(prNumber)) await this.getPullRequests([prNumber]);
		return this.bundles.get(prNumber) ?? null;
	}

	private buildQuery(numbers: number[]): string {
		const [owner, name] = this.id.slug.split('/');
		const aliases = numbers.map((n, i) => `pr${i}: pullRequest(number: ${n}) {${PR_FIELDS}\n}`).join('\n');
		return `query {
			viewer { login }
			repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
				${aliases}
			}
		}`;
	}

	private ingest(data: Json, numbers: number[]): void {
		this.viewerLogin = asStr(dig(data, 'viewer', 'login')) ?? this.viewerLogin;
		const repo = asObj(dig(data, 'repository'));
		if (!repo) throw new ForgeError('not-found', `repository ${this.id.slug} not found`);
		numbers.forEach((n, i) => {
			const node = asObj(repo[`pr${i}`]);
			if (!node) return; // deleted on forge — caller marks the row
			const info = mapGithubPr(node);
			if (!info) return;
			this.bundles.set(n, { info, checks: mapGithubChecks(node), linkedTickets: mapGithubLinkedTickets(node) });
		});
	}

	private executeGraphQL(query: string): Promise<Json> {
		return executeGraphQL(
			{
				apiUrl: this.config.apiUrl,
				token: this.config.auth.token,
				http: this.config.options.http,
				onRateInfo: this.config.options.onRateInfo,
			},
			query,
		);
	}
}
