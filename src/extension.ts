/**
 * status-pipe extension entry point: wires the controller, views, and
 * commands (design/04-architecture.md).
 */

import * as vscode from 'vscode';

import { StatusPipeController } from './host/controller';
import { signInBitbucket, signInGithub } from './host/forgeSetup';
import { QueueEditorPanel, QueueViewProvider } from './host/queueViewProvider';

export function activate(context: vscode.ExtensionContext): void {
	const controller = new StatusPipeController(context);
	context.subscriptions.push(controller);

	const provider = new QueueViewProvider(controller, context.extensionUri);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(QueueViewProvider.viewType, provider));

	registerCommands(context, controller);
	void controller.initialize();
}

type Register = (id: string, fn: (...args: unknown[]) => unknown) => void;

function registerCommands(context: vscode.ExtensionContext, controller: StatusPipeController): void {
	const register: Register = (id, fn) => {
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	};
	register('statusPipe.openInEditor', () => QueueEditorPanel.open(controller, context.extensionUri));
	register('statusPipe.refresh', () => controller.refresh());
	register('statusPipe.signIn.github', () => signInGithub());
	register('statusPipe.signIn.bitbucket', () => signInBitbucket(context.secrets));
	register('statusPipe.revealTicketFile', (repoRoot, ticket) => {
		if (typeof repoRoot === 'string' && typeof ticket === 'string') {
			return controller.revealTicketFile(repoRoot, ticket);
		}
		return undefined;
	});
	registerAgentCommands(register, controller);
}

function registerAgentCommands(register: Register, controller: StatusPipeController): void {
	register('statusPipe.agents.startAll', () => controller.startAll());
	register('statusPipe.agents.stopAll', () => controller.stopAll());
	register('statusPipe.agents.tickNow', () => controller.startAll());
	register('statusPipe.agents.openLog', (repoRoot, agentId) => {
		if (typeof repoRoot === 'string' && typeof agentId === 'string') {
			void controller.agentControl(repoRoot, agentId, 'openLog');
		}
	});
}

export function deactivate(): void {
	// controller disposal happens via context.subscriptions
}
