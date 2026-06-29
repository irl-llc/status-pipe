/**
 * Vertical drag handle between the editor view's list and detail panes.
 * Reports a new list-pane width as the pointer moves; the parent clamps and
 * persists it. The handle occupies a fixed-width reserved slot so resting
 * geometry never shifts (design/05-ui.md no-layout-shift) — only its accent
 * changes on hover/drag.
 */

import { useCallback, type JSX } from 'react';

export interface SplitterProps {
	/** Current list-pane width in px (drag origin). */
	width: number;
	/** Called with the candidate new width during a drag; parent clamps it. */
	onResize: (width: number) => void;
	/** Called once with the final width when the drag ends, to persist it. */
	onResizeEnd?: (width: number) => void;
}

export function Splitter({ width, onResize, onResizeEnd }: SplitterProps): JSX.Element {
	const onPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>): void => {
			event.preventDefault();
			const startX = event.clientX;
			const startWidth = width;
			let lastWidth = startWidth;
			const onMove = (move: PointerEvent): void => {
				lastWidth = startWidth + (move.clientX - startX);
				onResize(lastWidth);
			};
			const onUp = (): void => {
				window.removeEventListener('pointermove', onMove);
				window.removeEventListener('pointerup', onUp);
				onResizeEnd?.(lastWidth);
			};
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onUp);
		},
		[width, onResize, onResizeEnd],
	);

	return (
		<div
			className="editor-splitter"
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize status list"
			onPointerDown={onPointerDown}
		/>
	);
}
