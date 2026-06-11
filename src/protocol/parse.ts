/**
 * Tolerant readers for protocol files (design/04-architecture.md).
 *
 * Agents rewrite these files at unpredictable times; a file caught
 * mid-rename, hand-edited, or written by a newer plugin must degrade to a
 * renderable card, never throw. Every accessor coerces rather than trusts.
 */

import {
	AckFile,
	AckTarget,
	ConfigFile,
	HistoryEntry,
	LaunchAgent,
	LaunchFile,
	OrchestratorFile,
	ParseResult,
	TicketFile,
	TicketPr,
	WaitingOn,
	WorkerState,
} from './types';

const PHASES = new Set([
	'planning',
	'implementation',
	'review',
	'fixing',
	'merging',
	'awaiting-merge',
	'merged',
	'blocked',
	'abandoned',
]);
const HEALTHS = new Set(['ok', 'waiting', 'blocked', 'error', 'done']);
const WAITING_KINDS = new Set(['build', 'review', 'comment', 'owner', 'merge']);
const ACK_WAITING_KINDS = new Set([...WAITING_KINDS, 'blockers']);
const CI_STATES = new Set(['unknown', 'pending', 'passing', 'failing']);
const PR_STATES = new Set(['open', 'merged', 'closed']);
const WORKER_STATUSES = new Set(['idle', 'running', 'error']);

type Json = Record<string, unknown>;

function str(v: unknown): string | null {
	return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function obj(v: unknown): Json | null {
	return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function objArray(v: unknown): Json[] {
	if (!Array.isArray(v)) return [];
	return v.map(obj).filter((x): x is Json => x !== null);
}

function enumStr<T extends string>(v: unknown, allowed: Set<string>, fallback: T): T {
	return typeof v === 'string' && allowed.has(v) ? (v as T) : fallback;
}

function parseJson(raw: string): ParseResult<Json> {
	try {
		const value = obj(JSON.parse(raw));
		if (!value) return { ok: false, reason: 'corrupt', raw, detail: 'not a JSON object' };
		return { ok: true, value };
	} catch (err) {
		return { ok: false, reason: 'corrupt', raw, detail: err instanceof Error ? err.message : String(err) };
	}
}

function checkSchemaVersion(json: Json, raw: string): ParseResult<Json> {
	const version = num(json.schemaVersion);
	if (version !== 1) {
		return { ok: false, reason: 'unknown-schema', raw, detail: `schemaVersion ${String(json.schemaVersion)}` };
	}
	return { ok: true, value: json };
}

function parseVersioned(raw: string): ParseResult<Json> {
	const parsed = parseJson(raw);
	return parsed.ok ? checkSchemaVersion(parsed.value, raw) : parsed;
}

function parseWaitingOn(v: unknown): WaitingOn | null {
	const w = obj(v);
	if (!w) return null;
	const kind = str(w.kind);
	const since = str(w.since);
	if (!kind || !WAITING_KINDS.has(kind) || !since) return null;
	return {
		kind: kind as WaitingOn['kind'],
		ref: str(w.ref),
		pr: num(w.pr),
		since,
		detail: str(w.detail),
	};
}

function parsePr(p: Json): TicketPr | null {
	const number = num(p.number);
	const head = str(p.head);
	const base = str(p.base);
	if (number === null || !head || !base) return null;
	return {
		number,
		url: str(p.url),
		head,
		base,
		draft: p.draft === true,
		state: enumStr(p.state, PR_STATES, 'open'),
		ci: enumStr(p.ci, CI_STATES, 'unknown'),
		part: str(p.part),
	};
}

function parseHistoryEntry(h: Json): HistoryEntry | null {
	const at = str(h.at);
	const note = str(h.note);
	if (!at || note === null) return null;
	return { at, phase: str(h.phase), note, runId: str(h.runId) };
}

function parseWorker(v: unknown): WorkerState | null {
	const w = obj(v);
	if (!w) return null;
	const status = str(w.status);
	if (!status || !WORKER_STATUSES.has(status)) return null;
	return {
		status: status as WorkerState['status'],
		taskId: str(w.taskId),
		startedAt: str(w.startedAt),
		heartbeatAt: str(w.heartbeatAt),
	};
}

type TicketCollections = Pick<TicketFile, 'prs' | 'blockers' | 'subTickets' | 'agentCommentIds' | 'history' | 'worker'>;

function ticketCollections(json: Json): TicketCollections {
	return {
		prs: objArray(json.prs)
			.map(parsePr)
			.filter((p): p is TicketPr => p !== null),
		blockers: strArray(json.blockers),
		subTickets: objArray(json.subTickets).map((s) => ({
			key: str(s.key) ?? '',
			url: str(s.url),
			topic: str(s.topic) ?? '',
			status: str(s.status),
		})),
		agentCommentIds: strArray(json.agentCommentIds),
		history: objArray(json.history)
			.map(parseHistoryEntry)
			.filter((h): h is HistoryEntry => h !== null),
		worker: parseWorker(json.worker),
	};
}

function ticketFromJson(json: Json, fallbackKey: string): TicketFile {
	return {
		schemaVersion: 1,
		repo: str(json.repo) ?? '',
		ticket: str(json.ticket) ?? fallbackKey,
		title: str(json.title) ?? fallbackKey,
		slug: str(json.slug),
		url: str(json.url),
		phase: enumStr(json.phase, PHASES, 'planning'),
		health: enumStr(json.health, HEALTHS, 'ok'),
		headline: str(json.headline) ?? '',
		waitingOn: parseWaitingOn(json.waitingOn),
		updatedAt: str(json.updatedAt) ?? '',
		...ticketCollections(json),
	};
}

/** @param fallbackKey the filename stem, used when the file omits/garbles `ticket` */
export function parseTicketFile(raw: string, fallbackKey: string): ParseResult<TicketFile> {
	const versioned = parseVersioned(raw);
	if (!versioned.ok) return versioned;
	return { ok: true, value: ticketFromJson(versioned.value, fallbackKey) };
}

function parkedFromJson(v: unknown): OrchestratorFile['parked'] {
	const p = obj(v);
	if (!p) return null;
	const since = str(p.since);
	const reason = str(p.reason);
	if (!since || reason === null) return null;
	return { since, reason, recheckAfter: str(p.recheckAfter) };
}

export function parseOrchestratorFile(raw: string): ParseResult<OrchestratorFile> {
	const versioned = parseVersioned(raw);
	if (!versioned.ok) return versioned;
	const json = versioned.value;
	return {
		ok: true,
		value: {
			schemaVersion: 1,
			repo: str(json.repo),
			passCount: num(json.passCount),
			lastPassStartedAt: str(json.lastPassStartedAt),
			lastPassFinishedAt: str(json.lastPassFinishedAt),
			staleWorkerMinutes: num(json.staleWorkerMinutes),
			parked: parkedFromJson(json.parked),
			note: str(json.note),
		},
	};
}

function ackTargetFromJson(v: unknown): AckTarget | null {
	const t = obj(v);
	if (!t) return null;
	const waitingKind = str(t.waitingKind);
	const waitingSince = str(t.waitingSince);
	if (!waitingKind || !ACK_WAITING_KINDS.has(waitingKind) || !waitingSince) return null;
	return { waitingKind: waitingKind as AckTarget['waitingKind'], waitingSince, ref: str(t.ref), pr: num(t.pr) };
}

interface AckIdentity {
	ticket: string;
	ackId: string;
	target: AckTarget;
}

function ackIdentityFromJson(json: Json): AckIdentity | null {
	const ticket = str(json.ticket);
	const ackId = str(json.ackId);
	const target = ackTargetFromJson(json.target);
	if (!ticket || !ackId || !/^[0-9a-f]{8}$/.test(ackId) || !target) return null;
	return { ticket, ackId, target };
}

function ackFromJson(json: Json, identity: AckIdentity): AckFile {
	return {
		schemaVersion: 1,
		kind: 'ready-for-look',
		...identity,
		stateUpdatedAt: str(json.stateUpdatedAt) ?? '',
		note: str(json.note),
		createdAt: str(json.createdAt) ?? '',
		createdBy: str(json.createdBy) ?? '',
	};
}

export function parseAckFile(raw: string): ParseResult<AckFile> {
	const versioned = parseVersioned(raw);
	if (!versioned.ok) return versioned;
	const identity = ackIdentityFromJson(versioned.value);
	if (!identity) {
		return { ok: false, reason: 'corrupt', raw, detail: 'missing/invalid ticket, ackId, or target' };
	}
	return { ok: true, value: ackFromJson(versioned.value, identity) };
}

function launchAgentFromJson(a: Json, index: number): LaunchAgent | null {
	const command = str(a.command);
	const mode = str(a.mode);
	if (!command || (mode !== 'tick' && mode !== 'daemon')) return null;
	const id = str(a.id) ?? `agent-${index}`;
	return {
		id,
		title: str(a.title) ?? id,
		command,
		args: strArray(a.args),
		stdin: str(a.stdin) ?? '',
		cwd: str(a.cwd) ?? '.',
		env: envFromJson(a.env),
		mode,
		intervalMinutes: num(a.intervalMinutes) ?? 10,
		timeoutMinutes: num(a.timeoutMinutes) ?? 45,
	};
}

function envFromJson(v: unknown): Record<string, string> {
	const env = obj(v) ?? {};
	const entries = Object.entries(env).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : []));
	return Object.fromEntries(entries);
}

export function parseLaunchFile(raw: string): ParseResult<LaunchFile> {
	const versioned = parseVersioned(raw);
	if (!versioned.ok) return versioned;
	const agents = objArray(versioned.value.agents)
		.map(launchAgentFromJson)
		.filter((a): a is LaunchAgent => a !== null);
	if (agents.length === 0) return { ok: false, reason: 'corrupt', raw, detail: 'no valid agents[] entries' };
	return { ok: true, value: { schemaVersion: 1, agents } };
}

function ticketSourceFromJson(tickets: Json): ConfigFile['ticketSource'] {
	const source = str(tickets.source);
	return source === 'github-issues' || source === 'jira-cloud' ? source : null;
}

function trustModeFromJson(json: Json): ConfigFile['trustMode'] {
	const mode = str(obj(json.trust)?.mode);
	return mode === 'single-maintainer' || mode === 'multi-maintainer' || mode === 'public' ? mode : null;
}

export function parseConfigFile(raw: string): ParseResult<ConfigFile> {
	const versioned = parseVersioned(raw);
	if (!versioned.ok) return versioned;
	const json = versioned.value;
	const tickets = obj(json.tickets) ?? {};
	const jira = obj(tickets.jira) ?? {};
	return {
		ok: true,
		value: {
			schemaVersion: 1,
			epicsDir: str(obj(json.epics)?.dir) ?? 'epics',
			inventoryLabel: str(obj(json.inventory)?.label) ?? 'agent-queue',
			ticketSource: ticketSourceFromJson(tickets),
			jiraSiteUrl: str(jira.siteUrl),
			jiraProjectKey: str(jira.projectKey),
			staleWorkerMinutes: num(json.staleWorkerMinutes),
			trustMode: trustModeFromJson(json),
		},
	};
}
