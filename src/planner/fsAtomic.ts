/**
 * Atomic whole-file write shared by the planner's filesystem ports: write a
 * sibling `<target>.tmp`, then rename it over the target so a concurrent reader
 * never sees a torn file (the pattern protocolIo.ts and ackWriter.ts describe).
 * On any failure the temp file is removed so a crashed write leaves no residue.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export async function writeFileAtomic(target: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp`;
	try {
		await fs.writeFile(tmp, content, 'utf8');
		await fs.rename(tmp, target);
	} catch (err) {
		await fs.unlink(tmp).catch(() => undefined);
		throw err;
	}
}
