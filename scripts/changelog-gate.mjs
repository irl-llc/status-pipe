#!/usr/bin/env node
// CI change-fragment gate.
//
// Fails a pull request that makes release-worthy changes without adding a
// Changie fragment under .changes/unreleased/. Docs/CI-only PRs and PRs
// carrying the `skip-changelog` label are skipped. The decision logic lives in
// the unit-tested pure module src/utils/changelogGate.ts (compiled to
// out/utils/changelogGate.js by `npm run compile-tests`); this script only
// gathers the PR's changed files + labels from the GitHub event and reports.
//
// Inputs (provided by the workflow): GH_PR_NUMBER. Authenticated `gh` CLI.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const GATE_MODULE = resolve(REPO_ROOT, 'out/utils/changelogGate.js');

function fail(message) {
	console.error(`changelog-gate: ${message}`);
	process.exit(1);
}

function gh(args) {
	const result = spawnSync('gh', args, { encoding: 'utf8' });
	if (result.error) {
		// gh not installed / failed to spawn: status is null and stdout/stderr
		// are undefined, so surface the spawn error itself.
		fail(`failed to run \`gh ${args.join(' ')}\`: ${result.error.message}`);
	}
	if (result.status !== 0) {
		fail(`\`gh ${args.join(' ')}\` failed (exit ${result.status}): ${result.stderr || result.stdout || '(no output)'}`);
	}
	return result.stdout;
}

async function main() {
	const prNumber = process.env.GH_PR_NUMBER;
	if (!prNumber) {
		fail('GH_PR_NUMBER is not set; this gate only runs on pull_request events.');
	}
	if (!existsSync(GATE_MODULE)) {
		fail(`compiled gate module missing at ${GATE_MODULE}; run \`npm run compile-tests\`.`);
	}

	const data = JSON.parse(gh(['pr', 'view', prNumber, '--json', 'files,labels']));
	const changedPaths = data.files.map((f) => f.path);
	const labels = data.labels.map((l) => l.name);

	// pathToFileURL: on Windows a bare absolute path (C:\...) is rejected by
	// dynamic import() as an unsupported URL scheme; a file:// URL works on all
	// platforms.
	const { evaluateChangelogGate, UNRELEASED_DIR } = await import(pathToFileURL(GATE_MODULE).href);

	// A Changie fragment must be a NEW file, so we need per-file change status
	// (added vs modified) — which `gh pr view` does not expose. The REST API
	// reports `status`, so treat only status === 'added' as added; a *modified*
	// existing fragment must not satisfy the gate. Fall back to the path
	// heuristic only if the repo slug is unavailable (never in CI).
	const repo = process.env.GITHUB_REPOSITORY;
	const addedPaths = repo
		? gh(['api', '--paginate', `repos/${repo}/pulls/${prNumber}/files`, '--jq', '.[] | select(.status=="added") | .filename'])
				.split('\n')
				.map((p) => p.trim())
				.filter(Boolean)
		: changedPaths.filter((p) => p.startsWith(UNRELEASED_DIR));

	const decision = evaluateChangelogGate({ changedPaths, addedPaths, labels });
	const line = `changelog-gate: ${decision.kind.toUpperCase()} — ${decision.reason}`;
	if (decision.kind === 'fail') {
		fail(decision.reason);
	}
	console.log(line);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
