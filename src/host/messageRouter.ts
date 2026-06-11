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
			return handleAck(controller, message, post);
		case 'withdrawAck':
			return handleWithdraw(controller, message, post);
		default:
			return routeControlMessage(controller, message);
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
