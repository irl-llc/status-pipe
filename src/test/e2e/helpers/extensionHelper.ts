/** Activation helper for the e2e suite (runs inside the VS Code host). */

import * as vscode from 'vscode';

import { EXTENSION_ID } from '../constants';

export async function activateExtension(): Promise<vscode.Extension<unknown>> {
	const extension = vscode.extensions.getExtension(EXTENSION_ID);
	if (!extension) throw new Error(`Extension ${EXTENSION_ID} not found`);
	if (!extension.isActive) await extension.activate();
	return extension;
}
