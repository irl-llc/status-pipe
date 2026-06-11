/**
 * Formats the GitHub Actions step output the scheduled auto-release emits so
 * the downstream publish job can decide whether to run and which ref to check
 * out.
 *
 * Why this exists: GitHub deliberately does NOT re-trigger workflow runs from a
 * Release created with the default GITHUB_TOKEN, so the auto-release job can't
 * rely on the `on: release` publish path in ci.yml (the failure
 * git-spice-code-extension hit as its issue #29). Instead it chains a publish
 * job in the same run, gated on these outputs.
 *
 * Kept as a pure function (no fs/process access) so it is unit-testable; the
 * `scripts/auto-release.mjs` wrapper appends the returned string to
 * `$GITHUB_OUTPUT`.
 */

export interface ReleaseOutput {
	/** True only when a release was actually cut (pending fragments, real run). */
	released: boolean;
	/** The created tag (e.g. `v0.1.0`); empty when nothing was released. */
	tag: string;
}

/**
 * Builds the `key=value` lines for `$GITHUB_OUTPUT` from a release result.
 * Always emits both keys (trailing newline) so the consuming job sees a
 * defined `released` even on a no-op day.
 */
export function formatReleaseOutput(result: ReleaseOutput): string {
	const released = result.released ? 'true' : 'false';
	return `released=${released}\ntag=${result.tag}\n`;
}
