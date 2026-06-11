/**
 * Git remote URL parsing for forge matching (design/03-forge.md).
 * Handles https, ssh://, and scp-like (git@host:owner/repo) forms.
 */

export interface ParsedRemote {
	host: string;
	/** "owner/name" — first two path segments, `.git` stripped. */
	slug: string;
}

export function parseRemote(remoteUrl: string): ParsedRemote | null {
	const url = remoteUrl.trim();
	return parseScpLike(url) ?? parseUrlForm(url);
}

function parseScpLike(url: string): ParsedRemote | null {
	// git@github.com:owner/repo.git — no scheme, colon separates host/path.
	const match = url.match(/^(?:[\w.-]+@)?([\w.-]+):([^/].*)$/);
	if (!match || url.includes('://')) return null;
	return makeRemote(match[1], match[2]);
}

function parseUrlForm(url: string): ParsedRemote | null {
	try {
		const u = new URL(url);
		return makeRemote(u.hostname, u.pathname);
	} catch {
		return null;
	}
}

function makeRemote(host: string, pathname: string): ParsedRemote | null {
	const segments = pathname.replace(/^\/+/, '').split('/').filter(Boolean);
	if (segments.length < 2) return null;
	const name = segments[1].replace(/\.git$/, '');
	if (!segments[0] || !name) return null;
	return { host: host.toLowerCase(), slug: `${segments[0]}/${name}` };
}

/**
 * Host match tolerating ssh subdomains (ssh.github.com ⊂ github.com),
 * mirroring git-spice's FromRemoteURL.
 */
export function hostMatches(remoteHost: string, forgeHost: string): boolean {
	const a = remoteHost.toLowerCase();
	const b = forgeHost.toLowerCase();
	return a === b || a.endsWith(`.${b}`);
}

/** Hostname of a base URL like "https://github.com". */
export function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return baseUrl.toLowerCase();
	}
}
