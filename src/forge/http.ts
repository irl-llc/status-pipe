/**
 * Minimal HTTP plumbing for forge implementations: an injectable client
 * (tests record requests; the fake forge serves them), a concurrency pool,
 * and rate-limit header capture.
 */

import { ForgeError } from './types';

export interface HttpResponse {
	status: number;
	header(name: string): string | null;
	body: string;
}

export interface HttpRequest {
	url: string;
	method: 'GET' | 'POST';
	headers: Record<string, string>;
	body?: string;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

/** Default client over global fetch. */
export const fetchHttpClient: HttpClient = async (request) => {
	let response: Response;
	try {
		response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
		});
	} catch (err) {
		throw new ForgeError('network', err instanceof Error ? err.message : String(err));
	}
	const body = await response.text();
	return { status: response.status, header: (name) => response.headers.get(name), body };
};

export interface RateInfo {
	/** Requests remaining in the window, when the forge reports it. */
	remaining: number | null;
	/** Window size, when reported. */
	limit: number | null;
	/** Epoch ms when the window resets. */
	resetAt: number | null;
}

export type RateListener = (info: RateInfo) => void;

/** Reads GitHub-style X-RateLimit headers; null fields when absent. */
export function readRateInfo(response: HttpResponse): RateInfo {
	const remaining = response.header('x-ratelimit-remaining');
	const limit = response.header('x-ratelimit-limit');
	const reset = response.header('x-ratelimit-reset');
	return {
		remaining: remaining !== null ? Number(remaining) : null,
		limit: limit !== null ? Number(limit) : null,
		resetAt: reset !== null ? Number(reset) * 1000 : null,
	};
}

/** Maps an HTTP error status to a ForgeError; returns null for success. */
export function statusToForgeError(response: HttpResponse): ForgeError | null {
	if (response.status < 400) return null;
	if (response.status === 401) return new ForgeError('auth', 'authentication failed (401)');
	if (response.status === 404) return new ForgeError('not-found', 'not found (404)');
	if (response.status === 403 || response.status === 429) {
		return new ForgeError('rate-limit', `rate limited (${response.status})`, retryAfterMs(response));
	}
	return new ForgeError('network', `HTTP ${response.status}`);
}

function retryAfterMs(response: HttpResponse): number | null {
	const retryAfter = response.header('retry-after');
	if (retryAfter !== null && /^\d+$/.test(retryAfter)) return Date.now() + Number(retryAfter) * 1000;
	const info = readRateInfo(response);
	return info.resetAt;
}

/** A small FIFO concurrency limiter (Bitbucket's 4-way fetch pool). */
export class RequestPool {
	private active = 0;
	private readonly queue: Array<() => void> = [];

	constructor(private readonly limit: number) {}

	async run<T>(task: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await task();
		} finally {
			this.release();
		}
	}

	private acquire(): Promise<void> {
		if (this.active < this.limit) {
			this.active += 1;
			return Promise.resolve();
		}
		return new Promise((resolve) =>
			this.queue.push(() => {
				this.active += 1;
				resolve();
			}),
		);
	}

	private release(): void {
		this.active -= 1;
		const next = this.queue.shift();
		if (next) next();
	}
}
