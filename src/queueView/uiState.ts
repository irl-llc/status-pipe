/**
 * Webview-local UI state that should survive reloads (editor pane sizing).
 * Persisted through acquireVsCodeApi().getState/setState — vscode-free here
 * so it stays unit-testable and the bundle owns the persistence wiring.
 */

/** Default width (px) of the editor view's left list pane — matches the CSS
 * baseline so the first render is unchanged when no width has been stored. */
export const DEFAULT_EDITOR_LIST_WIDTH = 340;

/** Resize bounds: keep the list usable and never let it swallow the detail. */
export const MIN_EDITOR_LIST_WIDTH = 240;
export const MAX_EDITOR_LIST_WIDTH = 640;

export interface UiState {
	editorListWidth: number;
}

/** Clamp a candidate list width to the allowed range. */
export function clampEditorListWidth(width: number): number {
	if (!Number.isFinite(width)) return DEFAULT_EDITOR_LIST_WIDTH;
	return Math.min(MAX_EDITOR_LIST_WIDTH, Math.max(MIN_EDITOR_LIST_WIDTH, Math.round(width)));
}

/** Read editorListWidth from a persisted blob, falling back to the default. */
export function readEditorListWidth(raw: unknown): number {
	const value = (raw as Partial<UiState> | null | undefined)?.editorListWidth;
	return typeof value === 'number' ? clampEditorListWidth(value) : DEFAULT_EDITOR_LIST_WIDTH;
}
