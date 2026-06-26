/**
 * Inventory discovery (plugin/commands/tick.md Step 1): the candidate universe
 * is the epics' tracking tickets plus the trust-filtered labeled tickets,
 * deduplicated by key (an epic's tracking ticket IS the epic, not a second
 * work item). Epic mode mints a tracking ticket when a spec lacks one.
 */

import { TrustMode } from '../protocol/types';
import { EpicSpec, PlannerPorts } from './ports';
import { passesAssigneeScope, passesTrust } from './trust';
import { PlanReport } from './types';

/** A unit of dispatchable work, resolved to a stable key and worktree slug. */
export interface Candidate {
	key: string;
	kind: 'ticket' | 'epic';
	/** Title/url carried so a first-seen item can mint its ticket file. */
	title: string;
	url: string | null;
	/** Absolute spec path for epics (the `work-epic` argument); null for tickets. */
	epicPath: string | null;
	/** Worktree slug — the epic slug, or `ticket-<key>`. */
	slug: string;
}

interface ResolvedTrust {
	mode: TrustMode;
	operators: string[];
}

function epicTitle(name: string): string {
	return `Epic: ${name} — implementation tracking`;
}

/** A spec resolved to its tracking ticket key, flagged if this pass minted it. */
interface ResolvedEpic {
	spec: EpicSpec;
	key: string;
	created: boolean;
	/** Forge URL of the tracking ticket, carried so a first-seen epic's stamped
	 *  ticket file (and its card's deep link) gets the link the planner already holds. */
	url: string | null;
}

/** A tracking ticket found or freshly minted for a forge title. */
interface ResolvedTicket {
	key: string;
	url: string | null;
	minted: boolean;
}

async function findOrCreateTicket(ports: PlannerPorts, title: string, label: string): Promise<ResolvedTicket> {
	const existing = await ports.inventory.findTrackingTicket(title);
	if (existing) return { key: existing.key, url: existing.url, minted: false };
	const created = await ports.inventory.createTrackingTicket(title, label);
	return { key: created.key, url: created.url, minted: true };
}

/**
 * Resolve the spec's tracking ticket, minting at most one per forge title for
 * the whole pass via `minted`. find-before-create only dedups if no two mints
 * for the same title are ever in flight, so same-titled specs must share one
 * resolution; `created` is flagged on the FIRST spec of a title only.
 */
async function ensureTrackingTicket(
	ports: PlannerPorts,
	spec: EpicSpec,
	label: string,
	minted: Map<string, ResolvedTicket>,
): Promise<ResolvedEpic> {
	if (spec.trackingTicket) return { spec, key: spec.trackingTicket, created: false, url: null };
	const title = epicTitle(spec.title);
	const seen = minted.get(title);
	const ticket = seen ?? (await findOrCreateTicket(ports, title, label));
	if (!seen) minted.set(title, ticket);
	await ports.epics.writeTrackingHeader(spec.path, ticket.key, ticket.url);
	return { spec, key: ticket.key, created: !seen && ticket.minted, url: ticket.url };
}

/**
 * Resolve every spec to a tracking ticket, sequentially (not Promise.all) with a
 * title→ticket memo: createTrackingTicket is the planner's one irreversible side
 * effect, and concurrent finds for two same-titled specs both miss and mint a
 * duplicate. Few specs per pass, so the lost concurrency is negligible; report
 * order stays deterministic by spec.
 */
async function resolveEpics(ports: PlannerPorts, specs: EpicSpec[], label: string): Promise<ResolvedEpic[]> {
	const minted = new Map<string, ResolvedTicket>();
	const resolved: ResolvedEpic[] = [];
	for (const spec of specs) resolved.push(await ensureTrackingTicket(ports, spec, label, minted));
	return resolved;
}

/** Epic specs → candidates, ensuring each has a tracking ticket. */
export async function discoverEpics(
	ports: PlannerPorts,
	epicsDir: string,
	label: string,
	report: PlanReport,
): Promise<Candidate[]> {
	const resolved = await resolveEpics(ports, await ports.epics.list(epicsDir), label);
	for (const r of resolved) if (r.created) report.createdTrackingTickets.push(r.spec.slug);
	const candidates: Candidate[] = resolved.map((r) => ({
		key: r.key,
		kind: 'epic',
		title: r.spec.title,
		url: r.url,
		epicPath: r.spec.path,
		slug: r.spec.slug,
	}));
	// Two specs whose headers point at the same tracking ticket would otherwise
	// both dispatch — two workers stamping one ticket file. Keep the first per key.
	return dedupeByKey(candidates);
}

function dedupeByKey(candidates: Candidate[]): Candidate[] {
	const seen = new Set<string>();
	const out: Candidate[] = [];
	for (const c of candidates) {
		if (seen.has(c.key)) continue;
		seen.add(c.key);
		out.push(c);
	}
	return out;
}

/** Labeled tickets → candidates, after trust filtering and assignee scoping. */
export async function discoverTickets(
	ports: PlannerPorts,
	label: string,
	trust: ResolvedTrust,
	scope: string[],
): Promise<Candidate[]> {
	const tickets = await ports.inventory.listLabeledTickets(label);
	return tickets
		.filter((t) => passesTrust(t, trust.mode, trust.operators) && passesAssigneeScope(t, scope))
		.map((t) => ({
			key: t.key,
			kind: 'ticket' as const,
			title: t.title,
			url: t.url,
			epicPath: null,
			slug: `ticket-${t.key}`,
		}));
}

/** Union epics + tickets, dropping any labeled ticket that is itself an epic's tracking ticket. */
export function dedupeCandidates(epics: Candidate[], tickets: Candidate[]): Candidate[] {
	const epicKeys = new Set(epics.map((e) => e.key));
	return [...epics, ...tickets.filter((t) => !epicKeys.has(t.key))];
}
