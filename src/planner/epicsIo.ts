/**
 * Filesystem-backed EpicsPort (plugin/commands/tick.md Step 1, epic mode):
 * each `<epicsDir>/*.md` spec is an epic, selected by file. The spec's
 * `> **Tracking ticket:**` header (legacy `> **Tracking issue:**` accepted on
 * read) records the forge ticket the planner mints for it; writeTrackingHeader
 * stamps that header back so the next pass reuses the ticket instead of
 * re-creating it.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { byCodepoint } from '../utils/ordering';
import { writeFileAtomic } from './fsAtomic';
import { EpicSpec, EpicsPort } from './ports';

// The trailing `.*` makes the match span the WHOLE header line so an in-place
// replace overwrites any old ` — <url>` tail instead of leaving it dangling
// after the new header. Group 1 still captures just the key for trackingKeyOf.
const HEADER_RE = /^>\s*\*\*Tracking (?:ticket|issue):\*\*\s*(\S+).*/im;

export function createEpicsPort(): EpicsPort {
	return { list, writeTrackingHeader };
}

async function list(epicsDir: string): Promise<EpicSpec[]> {
	const names = await listMarkdown(epicsDir);
	const specs = await Promise.all(names.map((name) => readSpec(epicsDir, name)));
	// A spec that vanished or became unreadable mid-pass is skipped, not fatal —
	// one bad file must not take down discovery of every other epic. Sort by
	// codepoint (NOT localeCompare): epic order feeds the deterministic dispatch
	// schedule, which must be identical on the operator's host, the CLI, and CI.
	return specs.filter((s): s is EpicSpec => s !== null).sort((a, b) => byCodepoint(a.slug, b.slug));
}

async function readSpec(epicsDir: string, name: string): Promise<EpicSpec | null> {
	const slug = path.basename(name, '.md');
	const full = path.join(epicsDir, name);
	try {
		const text = await fs.readFile(full, 'utf8');
		// Prefer the spec's own `# ` heading for the title (it names the minted
		// tracking ticket); fall back to the slug when the file has no heading.
		return { slug, path: full, title: headingOf(text) ?? slug, trackingTicket: trackingKeyOf(text) };
	} catch {
		return null;
	}
}

/** The first markdown `# ` heading, trimmed; null if the spec has none. */
function headingOf(text: string): string | null {
	return text.match(/^#\s+(.+?)\s*$/m)?.[1] ?? null;
}

async function writeTrackingHeader(specPath: string, key: string, url: string | null): Promise<void> {
	const text = await fs.readFile(specPath, 'utf8');
	await writeFileAtomic(specPath, upsertHeader(text, headerLine(key, url)));
}

/** Key is the first token after the marker — forge-agnostic ("123" / "PROJ-7"). */
function trackingKeyOf(text: string): string | null {
	return HEADER_RE.exec(text)?.[1] ?? null;
}

function headerLine(key: string, url: string | null): string {
	return `> **Tracking ticket:** ${key}${url ? ` — ${url}` : ''}`;
}

/** Replace an existing tracking header in place, else insert it after the first heading (or at top). */
function upsertHeader(text: string, line: string): string {
	// Function replacer so `line` is inserted literally — a key/url containing
	// `$1`/`$&`/`$$` would otherwise be interpreted as a replacement pattern.
	if (HEADER_RE.test(text)) return text.replace(HEADER_RE, () => line);
	// Preserve the file's existing line ending so a CRLF spec doesn't pick up a
	// lone LF on the inserted line (mixed endings = noisy git diff on Windows).
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(eol);
	const headingAt = lines.findIndex((l) => /^#\s/.test(l));
	const at = headingAt >= 0 ? headingAt + 1 : 0;
	lines.splice(at, 0, ...(at === 0 ? [line, ''] : ['', line]));
	return lines.join(eol);
}

async function listMarkdown(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
	} catch {
		return [];
	}
}
