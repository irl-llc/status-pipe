/**
 * Typed message bus between extension host and webview
 * (design/04-architecture.md, message table). Discriminated unions; the
 * webview bundle imports only this and displayTypes.
 */

import { DisplayState } from '../queue/displayTypes';

export type ViewMode = 'tray' | 'editor';

export type ExtensionMessage =
	| { type: 'init'; mode: ViewMode }
	| { type: 'displayState'; state: DisplayState }
	| {
			type: 'ackResult';
			repoRoot: string;
			ticket: string;
			result: 'created' | 'already-sent' | 'error';
			detail?: string;
	  }
	| { type: 'withdrawResult'; repoRoot: string; ticket: string; result: 'withdrawn' | 'picked-up-first' | 'error' };

export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'openExternal'; url: string }
	| { type: 'revealTicketFile'; repoRoot: string; ticket: string }
	| { type: 'openEpicFile'; repoRoot: string; slug: string }
	| { type: 'ack'; repoRoot: string; ticket: string; note: string | null }
	| { type: 'withdrawAck'; repoRoot: string; ticket: string; ackId: string }
	| { type: 'restartWorker'; repoRoot: string; ticket: string }
	| {
			type: 'agentControl';
			repoRoot: string;
			agentId: string;
			action: 'start' | 'stop' | 'tickNow' | 'openLog' | 'retry';
	  }
	| { type: 'refresh'; repoRoot?: string };
