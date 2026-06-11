/**
 * Webview HTML shell with CSP — the git-spice-code-extension pattern:
 * default-src 'none', nonce-gated script, codicon css from dist/.
 */

import * as vscode from 'vscode';

const NONCE_LENGTH = 32;

export function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < NONCE_LENGTH; i += 1) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

function buildCsp(webview: vscode.Webview, nonce: string): string {
	return [
		`default-src 'none'`,
		`img-src ${webview.cspSource} https:`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
		`font-src ${webview.cspSource}`,
	].join('; ');
}

interface HtmlParts {
	csp: string;
	nonce: string;
	codiconCss: string;
	appCss: string;
	script: string;
}

function htmlTemplate(parts: HtmlParts): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${parts.csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${parts.codiconCss}" rel="stylesheet">
	<link href="${parts.appCss}" rel="stylesheet">
	<title>Status Pipe</title>
</head>
<body>
	<div id="queueRoot"></div>
	<div id="error" class="hidden"></div>
	<script nonce="${parts.nonce}" src="${parts.script}"></script>
</body>
</html>`;
}

export function renderWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = getNonce();
	const asUri = (...segments: string[]): string =>
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments)).toString();
	return htmlTemplate({
		csp: buildCsp(webview, nonce),
		nonce,
		codiconCss: asUri('dist', 'codicons', 'codicon.css'),
		appCss: asUri('media', 'queueView.css'),
		script: asUri('dist', 'queueView.js'),
	});
}
