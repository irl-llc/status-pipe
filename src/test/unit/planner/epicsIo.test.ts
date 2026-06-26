/**
 * Filesystem EpicsPort (src/planner/epicsIo.ts) against a real temp dir:
 * spec discovery, tracking-header parsing (current + legacy spelling), and the
 * header upsert that lets the next pass reuse a minted tracking ticket.
 */

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { createEpicsPort } from '../../../planner/epicsIo';

describe('planner/epicsIo', () => {
	let epicsDir: string;
	const epics = createEpicsPort();

	beforeEach(async () => {
		epicsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'status-pipe-epics-'));
	});

	afterEach(async () => {
		await fs.rm(epicsDir, { recursive: true, force: true });
	});

	async function spec(name: string, body: string): Promise<string> {
		const p = path.join(epicsDir, name);
		await fs.writeFile(p, body, 'utf8');
		return p;
	}

	it('lists *.md specs sorted, with slug/path and the title from the heading', async () => {
		await spec('payments.md', '# Payments Service\n');
		await spec('search.md', '# Search\n');
		await spec('notes.txt', 'ignored');
		const specs = await epics.list(epicsDir);
		assert.deepEqual(
			specs.map((s) => s.slug),
			['payments', 'search'],
		);
		assert.equal(specs[0].path, path.join(epicsDir, 'payments.md'));
		assert.equal(specs[0].title, 'Payments Service'); // from the `# ` heading, not the slug
	});

	it('sorts slugs by CODEPOINT, not numeric/locale collation (19 before 5)', async () => {
		await spec('5.md', '# Five\n');
		await spec('19.md', '# Nineteen\n');
		// Codepoint: '1' < '5', so '19' sorts before '5'. A numeric-aware localeCompare
		// would flip this to ['5','19'] and make epic dispatch order host-dependent.
		assert.deepEqual(
			(await epics.list(epicsDir)).map((s) => s.slug),
			['19', '5'],
		);
	});

	it('falls back to the slug as title when a spec has no heading', async () => {
		await spec('infra.md', 'no heading here, just body\n');
		assert.equal((await epics.list(epicsDir))[0].title, 'infra');
	});

	it('parses a tracking-ticket header, and the legacy "Tracking issue" spelling', async () => {
		await spec('a.md', '# A\n\n> **Tracking ticket:** 123 — https://x/123\n\nbody');
		await spec('b.md', '# B\n\n> **Tracking issue:** PROJ-7\n');
		await spec('c.md', '# C\n\nno header here\n');
		const byslug = Object.fromEntries((await epics.list(epicsDir)).map((s) => [s.slug, s.trackingTicket]));
		assert.equal(byslug.a, '123');
		assert.equal(byslug.b, 'PROJ-7');
		assert.equal(byslug.c, null);
	});

	describe('writeTrackingHeader', () => {
		it('inserts a header after the first heading and round-trips through list', async () => {
			const p = await spec('a.md', '# Alpha\n\nthe spec body\n');
			await epics.writeTrackingHeader(p, '42', 'https://x/42');
			const text = await fs.readFile(p, 'utf8');
			assert.match(text, /# Alpha\n\n> \*\*Tracking ticket:\*\* 42 — https:\/\/x\/42/);
			assert.equal((await epics.list(epicsDir))[0].trackingTicket, '42');
		});

		it('replaces an existing header in place rather than duplicating it', async () => {
			const p = await spec('a.md', '# Alpha\n\n> **Tracking ticket:** 1\n\nbody\n');
			await epics.writeTrackingHeader(p, '2', null);
			const text = await fs.readFile(p, 'utf8');
			assert.equal((text.match(/Tracking ticket:/g) ?? []).length, 1);
			assert.match(text, /\*\*Tracking ticket:\*\* 2\n/);
		});

		it('overwrites a header that carried a URL tail, leaving nothing dangling', async () => {
			const p = await spec('a.md', '# Alpha\n\n> **Tracking ticket:** 1 — https://old/1\n\nbody\n');
			await epics.writeTrackingHeader(p, '2', 'https://new/2');
			const text = await fs.readFile(p, 'utf8');
			assert.equal((text.match(/Tracking ticket:/g) ?? []).length, 1);
			assert.match(text, /\*\*Tracking ticket:\*\* 2 — https:\/\/new\/2\n/);
			assert.doesNotMatch(text, /old/); // the previous URL tail is gone
		});

		it('inserts a key/url containing $-patterns literally (not as regex replacements)', async () => {
			const p = await spec('a.md', '# Alpha\n\n> **Tracking ticket:** 1\n\nbody\n');
			await epics.writeTrackingHeader(p, 'PROJ-9', 'https://x/q?a=$1&b=$$');
			const text = await fs.readFile(p, 'utf8');
			assert.match(text, /\*\*Tracking ticket:\*\* PROJ-9 — https:\/\/x\/q\?a=\$1&b=\$\$/);
		});

		it('preserves CRLF line endings when inserting a header', async () => {
			const p = await spec('a.md', '# Alpha\r\n\r\nbody\r\n');
			await epics.writeTrackingHeader(p, '7', null);
			const text = await fs.readFile(p, 'utf8');
			assert.doesNotMatch(text, /[^\r]\n/); // every LF stays paired with a CR
			assert.match(text, /\r\n> \*\*Tracking ticket:\*\* 7\r\n/);
		});

		it('inserts at the top when the spec has no heading', async () => {
			const p = await spec('a.md', 'just body, no heading\n');
			await epics.writeTrackingHeader(p, '9', null);
			const text = await fs.readFile(p, 'utf8');
			assert.ok(text.startsWith('> **Tracking ticket:** 9\n'), text);
		});
	});
});
