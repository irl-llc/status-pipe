/**
 * Shared GitHub GraphQL execution: one POST to `/graphql`, rate-info capture,
 * HTTP→ForgeError mapping, and the data/errors envelope unwrap. Both the PR
 * read path (github.ts) and the issue-inventory path (githubInventory.ts) run
 * through here so the transport and error classification live in one place.
 */

import { Json, asArr, asObj, asStr, dig, safeParse } from '../utils/json';
import { HttpClient, RateListener, readRateInfo, statusToForgeError } from './http';
import { ForgeError } from './types';

export interface GraphQLEndpoint {
	apiUrl: string;
	token: string;
	http: HttpClient;
	onRateInfo?: RateListener;
}

export async function executeGraphQL(endpoint: GraphQLEndpoint, query: string, variables?: Json): Promise<Json> {
	const response = await endpoint.http({
		url: `${endpoint.apiUrl}/graphql`,
		method: 'POST',
		headers: {
			authorization: `Bearer ${endpoint.token}`,
			'content-type': 'application/json',
			'user-agent': 'status-pipe',
		},
		body: JSON.stringify({ query, variables }),
	});
	endpoint.onRateInfo?.(readRateInfo(response));
	const httpError = statusToForgeError(response);
	if (httpError) throw httpError;
	return extractGraphQLData(response.body);
}

export function extractGraphQLData(body: string): Json {
	const parsed = asObj(safeParse(body));
	const errors = asArr(parsed?.errors);
	const data = asObj(parsed?.data);
	if (!data) {
		const message = asStr(dig(asObj(errors[0]), 'message')) ?? 'malformed GraphQL response';
		throw new ForgeError(classifyGraphQLError(message), message);
	}
	return data;
}

function classifyGraphQLError(message: string): 'auth' | 'rate-limit' | 'network' {
	if (/rate limit/i.test(message)) return 'rate-limit';
	if (/credentials|token|authorization/i.test(message)) return 'auth';
	return 'network';
}
