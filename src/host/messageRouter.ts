/**
 * Webview → host message handling (design/04-architecture.md message
 * table). One router shared by the tray view and the editor panel.
 */

import * as vscode from 'vscode';

import { StatusPipeController } from './controller';
import { ExtensionMessage, WebviewMessage } from './webviewTypes';

export type PostMessage = (message: ExtensionMessage) => void;

export async function routeWebviewMessage(
	controller: StatusPipeController,
	message: WebviewMessage,
	post: PostMessage,
): Promise<void> {
	switch (message.type) {
		case 'openExternal':
			return openExternal(message.url);
		case 'revealTicketFile':
			return controller.revealTicketFile(message.repoRoot, message.ticket);
		case 'openEpicFile':
			return controller.openEpicFile(message.repoRoot, message.slug);
		case 'ack':
		case 'withdrawAck':
		case 'removeTicket':
			return routeReplyMessage(controller, message, post);
		default:
			return routeControlMessage(controller, message);
	}
}

/** The messages that post a result back to the webview. */
async function routeReplyMessage(
	controller: StatusPipeController,
	message: Extract<WebviewMessage, { type: 'ack' | 'withdrawAck' | 'removeTicket' }>,
	post: PostMessage,
): Promise<void> {
	switch (message.type) {
		case 'ack':
			return handleAck(controller, message, post);
		case 'withdrawAck':
			return handleWithdraw(controller, message, post);
		case 'removeTicket':
			return handleRemoveTicket(controller, message, post);
	}
}

async function openExternal(url: string): Promise<void> {
	await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function routeControlMessage(controller: StatusPipeController, message: WebviewMessage): Promise<void> {
	switch (message.type) {
		case 'restartWorker':
			await controller.restartWorker(message.repoRoot);
			return;
		case 'openWorkerLog':
			await controller.openWorkerLog(message.repoRoot, message.ticket);
			return;
		case 'agentControl':
			await controller.agentControl(message.repoRoot, message.agentId, message.action);
			return;
		case 'refresh':
			controller.refresh(message.repoRoot);
			return;
		default:
			return; // 'ready' is handled by the view provider
	}
}

async function handleAck(
	controller: StatusPipeController,
	message: Extract<WebviewMessage, { type: 'ack' }>,
	post: PostMessage,
): Promise<void> {
	const result = await controller.ack(message.repoRoot, message.ticket, message.note);
	post({ type: 'ackResult', repoRoot: message.repoRoot, ticket: message.ticket, result });
}

async function handleWithdraw(
	controller: StatusPipeController,
	message: Extract<WebviewMessage, { type: 'withdrawAck' }>,
	post: PostMessage,
): Promise<void> {
	const result = await controller.withdrawAck(message.repoRoot, message.ticket, message.ackId);
	post({ type: 'withdrawResult', repoRoot: message.repoRoot, ticket: message.ticket, result });
}

async function handleRemoveTicket(
	controller: StatusPipeController,
	message: Extract<WebviewMessage, { type: 'removeTicket' }>,
	post: PostMessage,
): Promise<void> {
	const result = await controller.removeTicket(message.repoRoot, message.ticket);
	post({ type: 'removeResult', repoRoot: message.repoRoot, ticket: message.ticket, result });
	// On success the card simply vanishes (the reload reflects the gone file), but a
	// refusal/failure leaves it in place with no visible reason — surface that, or the
	// operator clicks Remove and nothing happens. (The webview consumes no *Result yet.)
	if (result === 'not-allowed') {
		void vscode.window.showWarningMessage(`Status Pipe: ${message.ticket} can't be removed while it is still active.`);
	} else if (result === 'error') {
		// 'error' covers a revived/unknown ticket, an unsafe key, or a failed unlink.
		void vscode.window.showErrorMessage(`Status Pipe: could not remove ${message.ticket} (it may no longer exist).`);
	}
}
