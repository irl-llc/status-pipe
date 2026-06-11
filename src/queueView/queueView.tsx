/**
 * Webview entry point: mounts the QueueApp React tree and bridges
 * acquireVsCodeApi (the git-spice-code-extension bootstrap pattern).
 * QueueApp posts 'ready' from its subscribe effect once its listener is
 * attached, so no message can be lost.
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { ExtensionMessage, WebviewMessage } from '../host/webviewTypes';
import { QueueApp } from './components/QueueApp';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

document.addEventListener('DOMContentLoaded', () => {
	try {
		bootstrap();
	} catch (err) {
		const errorEl = document.getElementById('error');
		if (errorEl) {
			errorEl.textContent = `Status Pipe init error: ${err instanceof Error ? err.message : String(err)}`;
			errorEl.classList.remove('hidden');
		}
	}
});

function bootstrap(): void {
	const vscode = acquireVsCodeApi();
	const container = document.getElementById('queueRoot');
	if (!container) throw new Error('#queueRoot not found in webview HTML');

	const post = (message: WebviewMessage): void => vscode.postMessage(message);
	const subscribe = (handler: (message: ExtensionMessage) => void): (() => void) => {
		const listener = (event: MessageEvent): void => handler(event.data as ExtensionMessage);
		window.addEventListener('message', listener);
		return () => window.removeEventListener('message', listener);
	};

	createRoot(container).render(createElement(QueueApp, { postMessage: post, subscribeMessages: subscribe }));
}
