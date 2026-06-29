/**
 * Argument parsing for the standalone `status-pipe` CLI (#39). Hand-rolled and
 * dependency-free — the binary stays small and gains no third-party parser to
 * audit. The only command today is `tick` (one deterministic planner pass); a
 * bare invocation defaults to it, so `status-pipe` and `status-pipe tick` are
 * equivalent. Pure: returns a discriminated result, never touches argv/exit.
 */

export interface TickOptions {
	/** Primary checkout to plan over; null ⇒ resolve from the process cwd. */
	repoRoot: string | null;
	/** Protocol-dir override; null ⇒ `<repoRoot>/.status-pipe`. */
	protocolDir: string | null;
	/** Concurrency cap written into the dispatch; null ⇒ the planner default. */
	maxConcurrent: number | null;
	/** Emit the machine-readable PlanResult as JSON instead of the text report. */
	json: boolean;
}

export type ParsedArgs =
	| { kind: 'run'; options: TickOptions }
	| { kind: 'help' }
	| { kind: 'version' }
	| { kind: 'error'; message: string };

const VALUE_FLAGS = new Set(['--repo-root', '--protocol-dir', '--max-concurrent']);

/** Drop a leading `tick` command word; anything else stays for flag parsing. */
function stripCommand(argv: string[]): string[] {
	return argv[0] === 'tick' ? argv.slice(1) : argv;
}

function emptyOptions(): TickOptions {
	return { repoRoot: null, protocolDir: null, maxConcurrent: null, json: false };
}

/** Apply a value flag; returns an error message, or null on success. */
function applyValue(opts: TickOptions, flag: string, value: string): string | null {
	if (flag === '--repo-root') opts.repoRoot = value;
	else if (flag === '--protocol-dir') opts.protocolDir = value;
	else return applyMaxConcurrent(opts, value);
	return null;
}

function applyMaxConcurrent(opts: TickOptions, value: string): string | null {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) return `--max-concurrent must be a positive integer, got "${value}"`;
	opts.maxConcurrent = n;
	return null;
}

type Step = { kind: 'ok'; next: number } | { kind: 'error'; message: string };

/** Consume the token at `i` (and its value, for a value flag). Flat: depth ≤ 2. */
function step(tokens: string[], i: number, opts: TickOptions): Step {
	const token = tokens[i];
	if (token === '--json') {
		opts.json = true;
		return { kind: 'ok', next: i };
	}
	if (!VALUE_FLAGS.has(token)) return { kind: 'error', message: `unknown argument: ${token}` };
	const value = tokens[i + 1];
	if (value === undefined) return { kind: 'error', message: `${token} requires a value` };
	const err = applyValue(opts, token, value);
	return err ? { kind: 'error', message: err } : { kind: 'ok', next: i + 1 };
}

export function parseArgs(argv: string[]): ParsedArgs {
	if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
	if (argv.includes('--version') || argv.includes('-V')) return { kind: 'version' };
	return parseTick(stripCommand(argv));
}

function parseTick(tokens: string[]): ParsedArgs {
	const opts = emptyOptions();
	for (let i = 0; i < tokens.length; i++) {
		const result = step(tokens, i, opts);
		if (result.kind === 'error') return { kind: 'error', message: result.message };
		i = result.next;
	}
	return { kind: 'run', options: opts };
}
