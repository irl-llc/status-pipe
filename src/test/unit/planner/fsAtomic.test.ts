/**
 * Atomic write helper (src/planner/fsAtomic.ts) against a real temp dir: it
 * creates missing parent dirs, writes through a temp file, and — the point of
 * the helper — never leaves a `.tmp` behind when the rename fails.
 */

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { writeFileAtomic } from '../../../planner/fsAtomic';

async function exists(p: string): Promise<boolean> {
	return fs.access(p).then(
		() => true,
		() => false,
	);
}

describe('planner/fsAtomic', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'status-pipe-atomic-'));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('writes content (creating parent dirs) and leaves no temp file', async () => {
		const target = path.join(dir, 'nested', 'out.txt');
		await writeFileAtomic(target, 'hello');
		assert.equal(await fs.readFile(target, 'utf8'), 'hello');
		assert.equal(await exists(`${target}.tmp`), false);
	});

	it('removes the temp file and rethrows when the rename fails', async () => {
		const target = path.join(dir, 'collide');
		await fs.mkdir(target); // a directory at the target makes rename(file → dir) fail
		await assert.rejects(writeFileAtomic(target, 'x'));
		assert.equal(await exists(`${target}.tmp`), false);
	});
});
