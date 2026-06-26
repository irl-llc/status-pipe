/**
 * The built-in planner as a Spawner (design/09-launch-and-supervision.md): a
 * `type:"built-in"` tick entry runs the in-process deterministic planner pass
 * instead of spawning `claude -p /status-pipe:tick`. It presents to the
 * SupervisedRunner as a one-shot process — it streams a report and "exits" 0 on
 * success, non-zero on failure or when killed — so the scheduled lifetime,
 * parking, and backoff machinery is reused unchanged. The pass writes
 * orchestrator.json via the protocol ports; the host's file watcher then feeds
 * the dispatch to the supervisor, exactly as the external tick did.
 *
 * The pass is NOT preemptible: it carries no AbortSignal, so a kill (stop /
 * timeout / dispose) cannot abort an in-flight git/forge call. kill() instead
 * settles the runner immediately with a non-zero exit and lets the orphaned
 * pass run to completion — its writes are idempotent and its late exit is
 * ignored — so a wedged pass can never strand the runner in `running`.
 */

import { ForgeInventory } from '../forge/types';
import { PlannerPassArgs, formatPlanReport, runPlannerPass } from '../planner/runPass';
import { PlanResult } from '../planner/types';
import { ConfigFile } from '../protocol/types';
import { ProcessEvents, ProcessHandle, Spawner } from '../supervisor/supervisedRunner';

/** Per-repo facts the planner pass needs, resolved lazily at spawn time. */
export interface PlannerRepo {
	/** `owner/name`, stamped into freshly-minted ticket files. */
	repo: string;
	/** Absolute `.status-pipe/` directory. */
	protocolDir: string;
	inventory: ForgeInventory | null;
	/** Whether a forge connection resolved at all — distinguishes "not connected
	 *  yet" (recoverable) from "connected but this forge has no issue inventory". */
	forgeConnected: boolean;
	config: ConfigFile | null;
}

const NO_INVENTORY_MSG =
	'[planner] this forge has no issue inventory — the built-in planner needs github-issues; set the tick entry to type:"claude"\n';

export interface PlannerSpawnDeps {
	/** Look up a repo by its absolute root (the resolved built-in entry cwd). */
	lookup(repoRoot: string): PlannerRepo | null;
	/** Keys with a live worker right now — never re-dispatched this pass. */
	liveWorkerKeys(repoRoot: string): string[];
	/** The pass runner; defaults to runPlannerPass. Injected in tests to drive
	 *  the exit/kill branches without a real forge + filesystem. */
	runPass?: (args: PlannerPassArgs) => Promise<PlanResult>;
}

/** Stream a one-line reason and settle the runner — the spawner's early-exit paths. */
function exitWith(events: ProcessEvents, code: number, message: string): ProcessHandle {
	events.onOutput(message);
	events.onExit(code);
	return { kill: () => undefined };
}

export function createPlannerSpawn(deps: PlannerSpawnDeps): Spawner {
	const runPass = deps.runPass ?? runPlannerPass;
	return (request, events) => {
		// The built-in tick's cwd is resolved to the absolute repo root by the host.
		const repo = deps.lookup(request.cwd);
		// A null lookup is a misconfigured cwd (e.g. a %home%-anchored built-in cwd the
		// built-in path doesn't expand), not a not-yet-connected forge — fail loud.
		if (!repo) return exitWith(events, 1, `[planner] no managed repo at ${request.cwd} — check the tick entry's cwd\n`);
		// Connected to a forge with no issue inventory (Bitbucket/Jira): the built-in
		// planner can't run — fail (not skip) so the operator switches to type:"claude".
		if (!repo.inventory && repo.forgeConnected) {
			return exitWith(events, 1, NO_INVENTORY_MSG);
		}
		// No forge connected yet: SKIP (exit 0), don't fail — a non-zero exit would
		// churn the scheduled runner to backoff → failed; exiting clean keeps it
		// polling so it recovers once a connection resolves.
		if (!repo.inventory)
			return exitWith(events, 0, '[planner] no forge connection yet — skipping this tick (will retry next interval)\n');
		const inventory = repo.inventory; // narrowed non-null for the deferred closure
		return runBuiltInPass(() => runPass(passArgs(deps, repo, request.cwd, inventory)), events);
	};
}

/** Drive one pass as a one-shot process; kill() settles immediately (see header). */
function runBuiltInPass(pass: () => Promise<PlanResult>, events: ProcessEvents): ProcessHandle {
	let settled = false;
	const exit = (code: number): void => {
		if (settled) return;
		settled = true;
		events.onExit(code);
	};
	void reportPass(pass, events, () => settled, exit);
	return { kill: () => exit(1) };
}

async function reportPass(
	pass: () => Promise<PlanResult>,
	events: ProcessEvents,
	killed: () => boolean,
	exit: (code: number) => void,
): Promise<void> {
	try {
		const result = await pass();
		// A killed pass already settled the runner; don't echo a stale report.
		if (!killed()) events.onOutput(formatPlanReport(result));
		exit(0);
	} catch (err) {
		if (!killed()) events.onOutput(`[planner] pass failed: ${err instanceof Error ? err.message : String(err)}\n`);
		exit(1);
	}
}

function passArgs(
	deps: PlannerSpawnDeps,
	repo: PlannerRepo,
	repoRoot: string,
	inventory: ForgeInventory,
): PlannerPassArgs {
	return {
		repo: repo.repo,
		repoRoot,
		protocolDir: repo.protocolDir,
		inventory,
		config: repo.config,
		liveWorkerKeys: deps.liveWorkerKeys(repoRoot),
	};
}
