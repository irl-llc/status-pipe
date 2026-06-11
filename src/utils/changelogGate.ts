/**
 * Pure decision logic for the CI change-fragment gate.
 *
 * Every PR that changes user-facing behavior must add a Changie fragment under
 * `.changes/unreleased/` (see CONTRIBUTING.md). This module decides whether a
 * given PR satisfies that requirement, skips it (docs/CI-only or opt-out
 * label), or fails it. The decision is a pure function of the PR's changed
 * paths and labels so it can be unit-tested without GitHub; a thin script
 * (`scripts/changelog-gate.mjs`) wires it to the workflow.
 */

/** Directory (repo-relative, POSIX) where pending Changie fragments live. */
export const UNRELEASED_DIR = '.changes/unreleased/';

/** Label a contributor adds to a PR to bypass the gate for non-release work. */
export const SKIP_LABEL = 'skip-changelog';

/**
 * Glob-free path prefixes/suffixes for changes that never warrant a release and
 * therefore do not require a fragment. Kept deliberately conservative: when in
 * doubt the gate requires a fragment, and the `skip-changelog` label is the
 * documented escape hatch.
 */
const NON_RELEASE_PREFIXES = [
	'docs/',
	'design/',
	'.github/',
	'.changes/',
	'.vscode/',
	// Tests and build/dev tooling never ship to users, so they never warrant a
	// changelog entry (no more manual `skip-changelog` labels on test/CI PRs).
	'src/test/',
	'scripts/',
];

/** Exact repo-relative paths that never warrant a release. */
const NON_RELEASE_FILES = [
	'README.md',
	'CHANGELOG.md',
	'CONTRIBUTING.md',
	'LICENSE',
	// Test-image infra (the Playwright/snapshot Docker harness).
	'Dockerfile',
	'.dockerignore',
	'docker-compose.test.yml',
];

/**
 * File basenames that never warrant a release, matched at ANY directory depth
 * (not just the repo root) — tooling/config dotfiles, lockfiles, and compiler
 * config, including nested ones in sub-packages or dependency-bot updates.
 */
const NON_RELEASE_BASENAMES = [
	'.gitignore',
	'.gitattributes',
	'.prettierrc',
	'.prettierignore',
	'.eslintrc',
	'eslint.config.mjs',
	'package-lock.json',
	'tsconfig.json',
];

const NON_RELEASE_SUFFIXES = ['.md'];

/** Last path segment of a repo-relative POSIX path. */
function basename(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash === -1 ? path : path.slice(slash + 1);
}

/** Why the gate reached its decision, for human-readable CI output. */
export type GateDecision =
	| { kind: 'pass'; reason: string }
	| { kind: 'skip'; reason: string }
	| { kind: 'fail'; reason: string };

export interface GateInput {
	/** Repo-relative POSIX paths changed by the PR (added/modified/removed). */
	changedPaths: string[];
	/** Paths newly ADDED by the PR (a fragment must be a new file). */
	addedPaths: string[];
	/** Labels currently on the PR. */
	labels: string[];
}

function isNonReleasePath(path: string): boolean {
	if (NON_RELEASE_FILES.includes(path)) {
		return true;
	}
	if (NON_RELEASE_BASENAMES.includes(basename(path))) {
		return true;
	}
	if (NON_RELEASE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
		return true;
	}
	return NON_RELEASE_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

function hasAddedFragment(addedPaths: string[]): boolean {
	return addedPaths.some((path) => path.startsWith(UNRELEASED_DIR) && path !== `${UNRELEASED_DIR}.gitkeep`);
}

/**
 * Decides whether a PR satisfies the change-fragment requirement.
 *
 * Order of precedence:
 *   1. `skip-changelog` label  → skip (explicit opt-out).
 *   2. an added fragment file  → pass.
 *   3. all changes non-release → skip (docs/CI-only).
 *   4. otherwise               → fail (release-worthy change, no fragment).
 */
function buildFailReason(releasePaths: string[]): string {
	const sample = releasePaths.slice(0, 5).join(', ');
	return (
		`release-worthy changes without a change fragment (e.g. ${sample}). ` +
		`Add a fragment under ${UNRELEASED_DIR} (\`changie new\`) ` +
		`or apply the '${SKIP_LABEL}' label if this PR needs no release.`
	);
}

export function evaluateChangelogGate(input: GateInput): GateDecision {
	if (input.labels.includes(SKIP_LABEL)) {
		return { kind: 'skip', reason: `'${SKIP_LABEL}' label present` };
	}
	if (hasAddedFragment(input.addedPaths)) {
		return { kind: 'pass', reason: `added a change fragment under ${UNRELEASED_DIR}` };
	}
	const releasePaths = input.changedPaths.filter((path) => !isNonReleasePath(path));
	if (releasePaths.length === 0) {
		return { kind: 'skip', reason: 'only docs/CI/non-release files changed; no fragment required' };
	}
	return { kind: 'fail', reason: buildFailReason(releasePaths) };
}
