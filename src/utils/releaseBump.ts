/**
 * Pure semver-derivation logic for the scheduled auto-release (see
 * design/06-testing-and-release.md).
 *
 * The daily auto-release batches pending Changie fragments under
 * `.changes/unreleased/` into a new version. The bump level is derived from the
 * fragments' `kind` values, mapped through the same policy encoded in
 * `.changie.yaml`'s `auto:` levels. This module keeps that mapping and the
 * 0.x version arithmetic as a pure function so it can be unit-tested without
 * running Changie or touching git; the workflow script (`scripts/auto-release.mjs`)
 * wires it to the repository.
 *
 * Versioning policy: the extension is pre-1.0, so we stay on `0.x`. Per
 * semver-for-0.x, a feature OR a breaking change bumps the MINOR component (we
 * never bump major while on `0.x`); a bug fix bumps the PATCH component.
 * Docs-only changes never produce a fragment, so they never release.
 */

/** Semantic bump levels we derive for a release. `none` means no release. */
export type BumpLevel = 'minor' | 'patch' | 'none';

/**
 * Changie `kind` label → bump level, matching the `auto:` levels in
 * `.changie.yaml`. Kept here (not read from YAML) so the mapping is typed and
 * unit-tested; the two MUST stay in sync — `releaseBump.test.ts` documents the
 * expectation. While on `0.x` "minor" subsumes what would be a major bump.
 */
export const KIND_BUMP: Readonly<Record<string, Exclude<BumpLevel, 'none'>>> = {
	Added: 'minor',
	Changed: 'minor',
	Deprecated: 'minor',
	Removed: 'minor',
	Fixed: 'patch',
	Security: 'patch',
};

/** A parsed semantic version on the `major.minor.patch` form. */
export interface SemVer {
	major: number;
	minor: number;
	patch: number;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parses a `major.minor.patch` string, throwing on anything else. */
export function parseSemVer(version: string): SemVer {
	const match = SEMVER_RE.exec(version.trim());
	if (!match) {
		throw new Error(`not a major.minor.patch version: ${version}`);
	}
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Renders a {@link SemVer} back to its `major.minor.patch` string form. */
export function formatSemVer(version: SemVer): string {
	return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * Derives the bump level for a set of pending fragment kinds. A single `minor`
 * kind wins over any number of `patch` kinds; an empty set means no release.
 * Unknown kinds are ignored (treated as non-releasing) so a typo can never
 * silently escalate a release.
 */
export function deriveBumpLevel(kinds: readonly string[]): BumpLevel {
	let result: BumpLevel = 'none';
	for (const kind of kinds) {
		const level = KIND_BUMP[kind];
		if (level === 'minor') {
			return 'minor';
		}
		if (level === 'patch') {
			result = 'patch';
		}
	}
	return result;
}

/**
 * Applies a bump level to a current version, staying on `0.x` semantics:
 *   - `minor` → `0.(minor+1).0`
 *   - `patch` → `0.minor.(patch+1)`
 *   - `none`  → unchanged (caller should skip the release)
 */
export function applyBump(current: SemVer, level: BumpLevel): SemVer {
	if (level === 'minor') {
		return { major: current.major, minor: current.minor + 1, patch: 0 };
	}
	if (level === 'patch') {
		return { major: current.major, minor: current.minor, patch: current.patch + 1 };
	}
	return { ...current };
}

/**
 * Convenience end-to-end: from the current version string and the pending
 * fragment kinds, return the next version string and the bump that produced it.
 * Returns `nextVersion === null` when there is nothing to release.
 */
export function deriveNextVersion(
	currentVersion: string,
	kinds: readonly string[],
): { level: BumpLevel; nextVersion: string | null } {
	const level = deriveBumpLevel(kinds);
	if (level === 'none') {
		return { level, nextVersion: null };
	}
	const next = applyBump(parseSemVer(currentVersion), level);
	return { level, nextVersion: formatSemVer(next) };
}
