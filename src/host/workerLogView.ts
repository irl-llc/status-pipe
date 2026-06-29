/**
 * The read side of worker logs (design/09): open a worker's persisted log in an
 * editor — the crashed-worker card's post-mortem surface. Split from the
 * vscode-free fs sink in workerLogStore.ts so that (and its rotation logic) can
 * be unit-tested without importing vscode.
 */

import * as vscode from 'vscode';

import { workerLogPath } from '../supervisor/workerLog';

/** An absent file (worker never ran, or its log rotated out) shows an info
 *  message rather than failing. */
export async function showWorkerLog(protocolDir: string, key: string): Promise<void> {
	const file = vscode.Uri.file(workerLogPath(protocolDir, key));
	await vscode.window
		.showTextDocument(file)
		.then(undefined, () => vscode.window.showInformationMessage(`Status Pipe: no worker log captured yet for ${key}.`));
}
