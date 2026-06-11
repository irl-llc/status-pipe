/**
 * View providers (design/04-architecture.md): the side-tray WebviewView
 * and the editor-tab WebviewPanel share one React bundle and one
 * DisplayState pipeline; a mode flag selects layout density. The
 * activity-bar badge carries the NEEDS-YOU count only.
 */

import * as vscode from 'vscode';

import { StatusPipeController } from './controller';
import { routeWebviewMessage } from './messageRouter';
import { renderWebviewHtml } from './webviewHtml';
import { ExtensionMessage, ViewMode, WebviewMessage } from './webviewTypes';

function buildMessageHandler(
	mode: ViewMode,
	controller: StatusPipeController,
	post: (message: ExtensionMessage) => void,
): (message: WebviewMessage) => void {
	return (message) => {
		if (message.type === 'ready') {
			post({ type: 'init', mode });
			post({ type: 'displayState', state: controller.currentState() });
			return;
		}
		void routeWebviewMessage(controller, message, post);
	};
}

function wireWebview(
	webview: vscode.Webview,
	mode: ViewMode,
	controller: StatusPipeController,
	extensionUri: vscode.Uri,
): vscode.Disposable {
	webview.options = { enableScripts: true, localResourceRoots: [extensionUri] };
	webview.html = renderWebviewHtml(webview, extensionUri);
	const post = (message: ExtensionMessage): void => void webview.postMessage(message);
	return vscode.Disposable.from(
		webview.onDidReceiveMessage(buildMessageHandler(mode, controller, post)),
		controller.subscribe((state) => post({ type: 'displayState', state })),
	);
}

export class QueueViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = 'statusPipe.queue';
	private view: vscode.WebviewView | null = null;

	constructor(
		private readonly controller: StatusPipeController,
		private readonly extensionUri: vscode.Uri,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const wired = wireWebview(view.webview, 'tray', this.controller, this.extensionUri);
		const badge = this.controller.subscribe((state) => {
			view.badge =
				state.counts.needsYou > 0
					? { value: state.counts.needsYou, tooltip: `${state.counts.needsYou} need you` }
					: undefined;
		});
		this.controller.setViewVisible(view.visible);
		view.onDidChangeVisibility(() => this.controller.setViewVisible(view.visible));
		view.onDidDispose(() => {
			wired.dispose();
			badge.dispose();
			this.view = null;
			this.controller.setViewVisible(false);
		});
	}
}

export class QueueEditorPanel {
	private static current: vscode.WebviewPanel | null = null;

	static open(controller: StatusPipeController, extensionUri: vscode.Uri): void {
		if (QueueEditorPanel.current) {
			QueueEditorPanel.current.reveal();
			return;
		}
		const panel = vscode.window.createWebviewPanel('statusPipe.editor', 'Status Pipe', vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [extensionUri],
		});
		const wired = wireWebview(panel.webview, 'editor', controller, extensionUri);
		const statusBar = QueueEditorPanel.buildStatusBar(controller);
		controller.setViewVisible(true);
		panel.onDidDispose(() => {
			wired.dispose();
			statusBar.dispose();
			QueueEditorPanel.current = null;
		});
		QueueEditorPanel.current = panel;
	}

	/** Editor-mode status-bar item: NEEDS-YOU count at a glance (design/05). */
	private static buildStatusBar(controller: StatusPipeController): vscode.Disposable {
		const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
		item.command = 'statusPipe.openInEditor';
		const subscription = controller.subscribe((state) => {
			item.text = state.counts.needsYou > 0 ? `$(mail) ${state.counts.needsYou} need you` : '$(check) all quiet';
			item.tooltip = 'Status Pipe queue';
			item.show();
		});
		return vscode.Disposable.from(item, subscription);
	}
}
