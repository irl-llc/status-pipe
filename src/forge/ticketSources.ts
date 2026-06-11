/**
 * Ticketing sources (design/03-forge.md): a forge hosts PRs; a ticketing
 * source hosts the tracking tickets. GitHub plays both roles; Bitbucket
 * Cloud pairs with Jira Cloud.
 */

import { Json, asObj, asStr, dig } from '../utils/json';
import { HttpClient, statusToForgeError } from './http';
import { ForgeError, TicketRef, TicketSource } from './types';

export interface GithubIssuesOptions {
	baseUrl: string;
	apiUrl: string;
	slug: string;
	http: HttpClient;
	token: string;
}

export class GithubIssuesSource implements TicketSource {
	readonly id = 'github-issues';

	constructor(private readonly options: GithubIssuesOptions) {}

	ticketUrl(key: string): string {
		return `${this.options.baseUrl}/${this.options.slug}/issues/${key}`;
	}

	async getTicket(key: string): Promise<TicketRef & { status?: string }> {
		const { apiUrl, slug, http, token } = this.options;
		const json = await getJson(http, `${apiUrl}/repos/${slug}/issues/${key}`, {
			authorization: `Bearer ${token}`,
		});
		return {
			key,
			title: asStr(json.title) ?? undefined,
			url: asStr(json.html_url) ?? this.ticketUrl(key),
			status: asStr(json.state) ?? undefined,
		};
	}
}

export interface JiraCloudOptions {
	/** e.g. https://your-org.atlassian.net */
	siteUrl: string;
	email: string;
	apiToken: string;
	http: HttpClient;
}

export class JiraCloudSource implements TicketSource {
	readonly id = 'jira-cloud';

	constructor(private readonly options: JiraCloudOptions) {}

	private get site(): string {
		return this.options.siteUrl.replace(/\/$/, '');
	}

	ticketUrl(key: string): string {
		return `${this.site}/browse/${key}`;
	}

	async getTicket(key: string): Promise<TicketRef & { status?: string }> {
		const auth = Buffer.from(`${this.options.email}:${this.options.apiToken}`).toString('base64');
		const json = await getJson(this.options.http, `${this.site}/rest/api/3/issue/${key}?fields=summary,status`, {
			authorization: `Basic ${auth}`,
		});
		return {
			key,
			title: asStr(dig(json, 'fields', 'summary')) ?? undefined,
			url: this.ticketUrl(key),
			status: asStr(dig(json, 'fields', 'status', 'name')) ?? undefined,
		};
	}
}

async function getJson(http: HttpClient, url: string, headers: Record<string, string>): Promise<Json> {
	const response = await http({
		url,
		method: 'GET',
		headers: { ...headers, accept: 'application/json', 'user-agent': 'status-pipe' },
	});
	const error = statusToForgeError(response);
	if (error) throw error;
	const json = asObj(safeParse(response.body));
	if (!json) throw new ForgeError('network', 'malformed ticket response');
	return json;
}

function safeParse(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}
