/**
 * Parser + reducer for the Claude Code `--output-format stream-json` NDJSON
 * the launcher emits (design/03-forge.md "agent output" — the `claude-code`
 * output schema). vscode-free and pure: feed it raw stdout chunks, read back
 * a rolling AgentActivity the webview renders as a live status card.
 *
 * The stream is one JSON object per line:
 *   {type:"system", subtype:"init", model, tools, cwd, session_id}
 *   {type:"assistant", message:{content:[{type:"text",text} | {type:"tool_use",name,input}], usage}}
 *   {type:"user", message:{content:[{type:"tool_result", is_error}]}}
 *   {type:"result", subtype, is_error, result, total_cost_usd, duration_ms, num_turns, usage}
 * Unknown shapes are ignored — the reducer never throws on a malformed line.
 */

export type ActivityPhase = 'starting' | 'working' | 'done' | 'error';

export interface AgentActivity {
	/** null until the first parseable event of a run. */
	phase: ActivityPhase | null;
	model: string | null;
	/** The most recent assistant text — what the agent is "saying". */
	lastText: string | null;
	/** The tool the agent most recently invoked (e.g. "Bash", "Edit"). */
	currentTool: string | null;
	/** A one-line summary of that tool call's target, when cheap to derive. */
	currentToolDetail: string | null;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number | null;
	durationMs: number | null;
	numTurns: number | null;
	/** Set once the run emits its terminal `result` event. */
	result: { ok: boolean; text: string | null } | null;
}

export function emptyActivity(): AgentActivity {
	return {
		phase: null,
		model: null,
		lastText: null,
		currentTool: null,
		currentToolDetail: null,
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		costUsd: null,
		durationMs: null,
		numTurns: null,
		result: null,
	};
}

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | null {
	return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}
function asArr(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}
function asStr(v: unknown): string | null {
	return typeof v === 'string' ? v : null;
}
function asNum(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** One line of NDJSON → a plain object, or null if it isn't parseable JSON. */
export function parseStreamLine(line: string): Json | null {
	const trimmed = line.trim();
	if (!trimmed || trimmed[0] !== '{') return null;
	try {
		return asObj(JSON.parse(trimmed));
	} catch {
		return null;
	}
}

/**
 * Folds the Claude stream into a rolling AgentActivity. One reducer per run;
 * call reset() when the launcher relaunches.
 */
export class ClaudeActivityReducer {
	private buffer = '';
	private activity = emptyActivity();

	snapshot(): AgentActivity {
		return { ...this.activity };
	}

	reset(): void {
		this.buffer = '';
		this.activity = emptyActivity();
	}

	/** Feed an arbitrary stdout chunk; complete lines are parsed, the rest held. */
	pushChunk(chunk: string): void {
		this.buffer += chunk;
		let nl: number;
		while ((nl = this.buffer.indexOf('\n')) !== -1) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			const event = parseStreamLine(line);
			if (event) this.apply(event);
		}
	}

	private apply(event: Json): void {
		switch (asStr(event.type)) {
			case 'system':
				return this.applySystem(event);
			case 'assistant':
				return this.applyAssistant(event);
			case 'result':
				return this.applyResult(event);
			default:
				return;
		}
	}

	private applySystem(event: Json): void {
		if (asStr(event.subtype) !== 'init') return;
		this.activity.phase = 'starting';
		this.activity.model = asStr(event.model) ?? this.activity.model;
	}

	private applyAssistant(event: Json): void {
		this.activity.phase = 'working';
		const message = asObj(event.message);
		if (!message) return;
		this.activity.model = asStr(message.model) ?? this.activity.model;
		this.applyUsage(asObj(message.usage));
		for (const block of asArr(message.content)) {
			this.applyContentBlock(asObj(block));
		}
	}

	private applyContentBlock(block: Json | null): void {
		if (!block) return;
		if (asStr(block.type) === 'text') {
			const text = asStr(block.text);
			if (text && text.trim()) this.activity.lastText = text.trim();
		} else if (asStr(block.type) === 'tool_use') {
			this.activity.toolCalls += 1;
			this.activity.currentTool = asStr(block.name);
			this.activity.currentToolDetail = toolDetail(asStr(block.name), asObj(block.input));
		}
	}

	private applyUsage(usage: Json | null): void {
		if (!usage) return;
		this.activity.inputTokens = asNum(usage.input_tokens) ?? this.activity.inputTokens;
		this.activity.outputTokens = asNum(usage.output_tokens) ?? this.activity.outputTokens;
	}

	private applyResult(event: Json): void {
		const isError = event.is_error === true || asStr(event.subtype)?.startsWith('error') === true;
		this.activity.phase = isError ? 'error' : 'done';
		this.activity.costUsd = asNum(event.total_cost_usd) ?? this.activity.costUsd;
		this.activity.durationMs = asNum(event.duration_ms) ?? this.activity.durationMs;
		this.activity.numTurns = asNum(event.num_turns) ?? this.activity.numTurns;
		this.applyUsage(asObj(event.usage));
		this.activity.result = { ok: !isError, text: asStr(event.result) };
	}
}

/** A short, human label for a tool call's target (best-effort, never throws). */
function toolDetail(name: string | null, input: Json | null): string | null {
	if (!input) return null;
	const path = asStr(input.file_path) ?? asStr(input.path) ?? asStr(input.notebook_path);
	if (path) return path.split('/').slice(-2).join('/');
	const command = asStr(input.command);
	if (command) return truncate(command);
	const pattern = asStr(input.pattern) ?? asStr(input.query) ?? asStr(input.url);
	if (pattern) return pattern;
	return name === 'Task' ? asStr(input.description) : null;
}

function truncate(text: string): string {
	return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
