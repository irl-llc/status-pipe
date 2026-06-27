/**
 * E2E-only display seam for live worker rows in the agents strip.
 *
 * Worker rows (AgentsStrip → WorkerRow) render from `DisplayState.workers`,
 * which the controller fills from the supervisor's in-memory `workerStates()`.
 * Every other test layer (the jsdom component tests) constructs `DisplayState`
 * directly, but the Playwright snapshot suite drives a real VS Code from
 * on-disk fixtures and so cannot — a real worker only exists once an APPROVED
 * `worker` launch entry is dispatch-spawned, which the disk-fixture harness has
 * no way to set up. This seam lets the snapshot layer construct the same input
 * the others do, with no other path to it.
 *
 * It is **display-only**: it injects already-running worker *state* into the
 * rendered model; it spawns nothing and executes no command, so — unlike a
 * launch-approval bypass — it carries zero trust/security weight (the worst an
 * attacker who set the env var could do is paint a fake row). Like the
 * `GITHUB_TOKEN` env read in forgeSetup it is an env-gated affordance the
 * extension host honors (env is the snapshot harness's only injection channel);
 * unlike it this variable has no production purpose at all — inert unless a test
 * sets it, never wired in prod.
 */

import { emptyActivity } from '../output/claudeStream';
import { WorkerProcessState } from '../queue/queueInputs';

const ENV_VAR = 'STATUS_PIPE_E2E_WORKERS';

/** One injected worker as the env JSON describes it; only `key` is required. */
interface FixtureWorker {
	key: string;
	currentTool?: string;
	currentToolDetail?: string;
}

/**
 * Worker states declared via `STATUS_PIPE_E2E_WORKERS` (a JSON array), attached
 * to the first discovered repo so the test never has to second-guess the
 * canonicalized repo root the queue model keys on. Returns `[]` when the env is
 * unset/malformed or no repo is discovered. An entry with a tool gets a
 * deterministic activity summary (no live duration) so snapshots are stable.
 */
export function e2eFixtureWorkers(repoRoots: string[]): WorkerProcessState[] {
	const raw = process.env[ENV_VAR];
	if (!raw || repoRoots.length === 0) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isFixtureWorker).map((w) => toWorkerState(w, repoRoots[0]));
	} catch {
		return [];
	}
}

function isFixtureWorker(v: unknown): v is FixtureWorker {
	return !!v && typeof (v as Record<string, unknown>).key === 'string';
}

function toWorkerState(w: FixtureWorker, repoRoot: string): WorkerProcessState {
	return {
		repoRoot,
		key: w.key,
		// null runningSince → the row shows activity (deterministic) rather than a
		// live, ticking uptime that would make the snapshot non-reproducible.
		runningSince: null,
		lastOutputAt: null,
		activity: {
			...emptyActivity(),
			phase: 'working',
			currentTool: w.currentTool ?? null,
			currentToolDetail: w.currentToolDetail ?? null,
		},
	};
}
