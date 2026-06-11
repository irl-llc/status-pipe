/**
 * Defensive accessors for untrusted JSON (forge API responses, protocol
 * files). Everything coerces instead of trusting; nothing throws.
 */

export type Json = Record<string, unknown>;

export function asObj(v: unknown): Json | null {
	return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

export function asArr(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

export function asStr(v: unknown): string | null {
	return typeof v === 'string' ? v : null;
}

export function asNum(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function asBool(v: unknown): boolean {
	return v === true;
}

/** Walks a path of keys through nested objects; null on any miss. */
export function dig(v: unknown, ...path: string[]): unknown {
	let cur: unknown = v;
	for (const key of path) {
		const o = asObj(cur);
		if (!o) return null;
		cur = o[key];
	}
	return cur ?? null;
}
