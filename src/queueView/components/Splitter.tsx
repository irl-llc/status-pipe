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
}

export function Splitter({ width, onResize }: SplitterProps): JSX.Element {
	const onPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>): void => {
			event.preventDefault();
			const startX = event.clientX;
			const startWidth = width;
			const onMove = (move: PointerEvent): void => onResize(startWidth + (move.clientX - startX));
			const onUp = (): void => {
				window.removeEventListener('pointermove', onMove);
				window.removeEventListener('pointerup', onUp);
			};
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onUp);
		},
		[width, onResize],
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
