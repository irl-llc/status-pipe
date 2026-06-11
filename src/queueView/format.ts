/**
 * Display formatting helpers for the webview (pure; jsdom-tested).
 */

export function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return 'now';
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h`;
}

export function formatAge(iso: string, now: number): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return '';
	return formatDuration(Math.max(0, now - ms));
}

export function formatClock(iso: string): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return '';
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	return `${hh}:${mm}`;
}

/** 2-line clamp source: strip markdown emphasis and newlines (full text on hover). */
export function plainHeadline(headline: string): string {
	return headline
		.replace(/[*_`#>]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Caption an enrichment count that hit the fetch cap. */
export function cappedCount(n: number, capped: boolean): string {
	return capped ? '100+' : String(n);
}
