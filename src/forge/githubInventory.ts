/**
 * GitHub issue inventory (plugin/commands/tick.md Steps 0–1): repo visibility
 * and authenticated identity for the trust gate, labeled-issue discovery, and
 * find-or-create of an epic's tracking issue. Reads go through GraphQL (one
 * round trip each); the single mutation (create) uses the REST issues endpoint,
 * which needs no repository/label node-id resolution.
 */

import { asArr, asNum, asObj, asStr, dig, safeParse } from '../utils/json';
import { GraphQLEndpoint, executeGraphQL } from './graphql';
import { HttpClient, RateListener, readRateInfo, statusToForgeError } from './http';
import { ForgeError, ForgeInventory, InventoryIssue } from './types';

const ISSUE_FIELDS = `number title url author { login } assignees(first: 20) { nodes { login } }`;
const VISIBILITY_QUERY = `query($o:String!,$n:String!){ repository(owner:$o,name:$n){ visibility } }`;
// `first:100` is a HARD ceiling — a single page, no cursor pagination. A backlog
// larger than 100 OPEN labeled issues silently truncates to the 100 most-recently
// updated; the long tail won't be dispatched until it re-surfaces. 100 is generous
// for an agent queue; revisit with pagination if queues realistically grow past it.
const LABELED_QUERY = `query($o:String!,$n:String!,$labels:[String!]){
	repository(owner:$o,name:$n){
		issues(first:100, states:OPEN, labels:$labels, orderBy:{field:UPDATED_AT, direction:DESC}){
			nodes { ${ISSUE_FIELDS} }
		}
	}
}`;
// first:50 (not 10): the exact-title match is what findIssueByTitle keeps, and
// GitHub relevance-ranks it high, but a wide page guards against an exact match
// past the cap being missed — which would mint a DUPLICATE tracking ticket.
const SEARCH_QUERY = `query($q:String!){ search(query:$q, type:ISSUE, first:50){ nodes { ... on Issue { ${ISSUE_FIELDS} } } } }`;

export interface GithubInventoryOptions {
	apiUrl: string;
	/** "owner/name". */
	slug: string;
	token: string;
	http: HttpClient;
	onRateInfo?: RateListener;
}

export class GithubInventory implements ForgeInventory {
	constructor(private readonly options: GithubInventoryOptions) {}

	private get endpoint(): GraphQLEndpoint {
		const { apiUrl, token, http, onRateInfo } = this.options;
		return { apiUrl, token, http, onRateInfo };
	}

	private owner(): [string, string] {
		const [owner, name] = this.options.slug.split('/');
		return [owner, name];
	}

	async visibility(): Promise<'public' | 'private'> {
		const [o, n] = this.owner();
		const data = await executeGraphQL(this.endpoint, VISIBILITY_QUERY, { o, n });
		// A null repository means bad credentials, a typo, or a deleted repo —
		// surface it like github.ts rather than silently reporting 'private'.
		const repo = asObj(dig(data, 'repository'));
		if (!repo) throw new ForgeError('not-found', `repository ${this.options.slug} not found`);
		// Fail closed: only an explicitly PRIVATE repo (GitHub REST `.private===true`,
		// design/07) gets the permissive single-maintainer default. PUBLIC, INTERNAL
		// (org-wide readable, `.private===false`), and any unexpected value map to
		// 'public', which REFUSES to tick without a declared trust mode.
		return asStr(dig(repo, 'visibility')) === 'PRIVATE' ? 'private' : 'public';
	}

	async viewerLogin(): Promise<string | null> {
		const data = await executeGraphQL(this.endpoint, 'query { viewer { login } }');
		return asStr(dig(data, 'viewer', 'login'));
	}

	async listLabeledIssues(label: string): Promise<InventoryIssue[]> {
		const [o, n] = this.owner();
		const data = await executeGraphQL(this.endpoint, LABELED_QUERY, { o, n, labels: [label] });
		// A null repository would silently look like an empty backlog; surface it
		// as not-found instead, mirroring github.ts.
		const repo = asObj(dig(data, 'repository'));
		if (!repo) throw new ForgeError('not-found', `repository ${this.options.slug} not found`);
		return mapIssueNodes(dig(repo, 'issues', 'nodes'));
	}

	async findIssueByTitle(title: string): Promise<InventoryIssue | null> {
		const q = `repo:${this.options.slug} is:issue is:open in:title ${JSON.stringify(title)}`;
		const data = await executeGraphQL(this.endpoint, SEARCH_QUERY, { q });
		// Search is fuzzy; require an exact-title match before reusing a ticket.
		return mapIssueNodes(dig(data, 'search', 'nodes')).find((i) => i.title === title) ?? null;
	}

	async createLabeledIssue(title: string, label: string): Promise<InventoryIssue> {
		const response = await this.options.http({
			url: `${this.options.apiUrl}/repos/${this.options.slug}/issues`,
			method: 'POST',
			headers: {
				authorization: `Bearer ${this.options.token}`,
				'content-type': 'application/json',
				accept: 'application/vnd.github+json',
				'user-agent': 'status-pipe',
			},
			body: JSON.stringify({ title, labels: [label] }),
		});
		this.options.onRateInfo?.(readRateInfo(response));
		const error = statusToForgeError(response);
		if (error) throw error;
		return parseCreatedIssue(response.body);
	}
}

function mapIssueNodes(nodes: unknown): InventoryIssue[] {
	return asArr(nodes)
		.map(mapGraphQLIssue)
		.filter((i): i is InventoryIssue => i !== null);
}

function mapGraphQLIssue(node: unknown): InventoryIssue | null {
	const number = asNum(dig(node, 'number'));
	if (number === null) return null;
	return {
		key: String(number),
		title: asStr(dig(node, 'title')) ?? '',
		url: asStr(dig(node, 'url')),
		author: asStr(dig(node, 'author', 'login')),
		assignees: loginsOf(dig(node, 'assignees', 'nodes')),
	};
}

function parseCreatedIssue(body: string): InventoryIssue {
	const json = asObj(safeParse(body));
	const number = asNum(json?.number);
	if (!json || number === null) throw new ForgeError('network', 'malformed issue-create response');
	return {
		key: String(number),
		title: asStr(json.title) ?? '',
		url: asStr(json.html_url),
		author: asStr(dig(json, 'user', 'login')),
		assignees: loginsOf(json.assignees),
	};
}

/** Pull `login` strings out of a node array (GraphQL `{nodes:[{login}]}` or REST `[{login}]`). */
function loginsOf(nodes: unknown): string[] {
	return asArr(nodes)
		.map((n) => asStr(dig(n, 'login')))
		.filter((s): s is string => s !== null);
}
