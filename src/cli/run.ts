/**
 * CLI orchestration: parse → discover → connect forge → run ONE planner pass →
 * render. Returns a {code, stdout, stderr} result instead of writing streams or
 * calling exit, so the whole flow is unit-testable end to end (main.ts is the
 * only place that touches the real process). The planner module does the actual
 * work — this is just the standalone plumbing the extension otherwise provides.
 */

import { Clock, PlanResult } from '../planner';
import { deriveLiveWorkerKeys } from '../planner/liveWorkers';
import { createProtocolReadPort } from '../planner/protocolIo';
import { formatPlanReport, plannerConfigFromFile, runPlannerPass } from '../planner/runPass';
import { ParsedArgs, TickOptions, parseArgs } from './args';
import { Discovered, discover } from './discover';
import { ForgeSetup, connectForge } from './forge';
import { HELP_TEXT, USAGE, VERSION } from './help';

export interface CliContext {
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** Fixed pass instant for deterministic tests; defaults to the wall clock. */
	now?: number;
}

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

function fail(message: string): CliResult {
	return { code: 1, stdout: '', stderr: `status-pipe: ${message}\n` };
}

function clockFor(ctx: CliContext): Clock {
	const ms = ctx.now ?? Date.now();
	return { now: () => ms, iso: () => new Date(ms).toISOString() };
}

/** Live workers, the standalone way: derived from on-disk ticket heartbeats (see liveWorkers.ts). */
function deriveLive(disc: Discovered, clock: Clock): Promise<string[]> {
	const cfg = plannerConfigFromFile(disc.config, disc.repoRoot);
	const read = createProtocolReadPort(disc.protocolDir);
	return deriveLiveWorkerKeys(read, cfg.staleWorkerMinutes, clock.now());
}

async function executePass(
	opts: TickOptions,
	disc: Discovered,
	forge: ForgeSetup,
	ctx: CliContext,
): Promise<PlanResult> {
	const clock = clockFor(ctx);
	const liveWorkerKeys = await deriveLive(disc, clock);
	return runPlannerPass({
		repo: forge.repoSlug,
		repoRoot: disc.repoRoot,
		protocolDir: disc.protocolDir,
		inventory: forge.inventory,
		config: disc.config,
		liveWorkerKeys,
		maxConcurrent: opts.maxConcurrent ?? undefined,
		clock,
	});
}

function render(result: PlanResult, json: boolean): CliResult {
	const code = result.report.refusedReason ? 1 : 0;
	const stdout = json ? `${JSON.stringify(result, null, 2)}\n` : formatPlanReport(result);
	return { code, stdout, stderr: '' };
}

async function runTick(opts: TickOptions, ctx: CliContext): Promise<CliResult> {
	try {
		const disc = await discover(ctx.cwd, opts.repoRoot, opts.protocolDir);
		if (!disc.ok) return fail(disc.message);
		const forge = await connectForge(disc.value.remoteUrl, ctx.env);
		if (!forge.ok) return fail(forge.message);
		return render(await executePass(opts, disc.value, forge.value, ctx), opts.json);
	} catch (err) {
		return fail(`planner pass failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function dispatch(parsed: ParsedArgs, ctx: CliContext): Promise<CliResult> | CliResult {
	switch (parsed.kind) {
		case 'help':
			return { code: 0, stdout: HELP_TEXT, stderr: '' };
		case 'version':
			return { code: 0, stdout: `${VERSION}\n`, stderr: '' };
		case 'error':
			return { code: 2, stdout: '', stderr: `status-pipe: ${parsed.message}\n${USAGE}\n` };
		case 'run':
			return runTick(parsed.options, ctx);
	}
}

export function run(argv: string[], ctx: CliContext): Promise<CliResult> | CliResult {
	return dispatch(parseArgs(argv), ctx);
}
