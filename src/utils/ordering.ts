/**
 * Deterministic string ordering. ALWAYS use this for any sort whose result is
 * observed cross-machine — dispatch order, ack consumption order, card tie-breaks
 * (the operator's host, the standalone CLI, the CI snapshot oracle must all agree).
 *
 * `String.prototype.localeCompare` (no locale arg) defers to the host's ICU
 * collation, which is locale- and ICU-version-dependent and can be numeric-aware
 * (ordering '5' before '19'). Codepoint comparison is identical on every machine.
 */

export function byCodepoint(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}
