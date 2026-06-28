/**
 * A status indicator whose meaning shows on hover (design/05-ui.md rule 6).
 *
 * The meaning renders as a DOM overlay (the `.tip` tooltip in queueView.css),
 * not a native `title` attribute. A native tooltip is drawn by the OS as
 * window chrome outside the page surface, so it cannot be pixel-tested — the
 * snapshot suite can never prove the meaning renders. A DOM tooltip is part of
 * the page: screenshot-verifiable, and `aria-label` gives screen readers the
 * same words. `position`-anchored, so it never shifts layout (rule 5).
 */

import type { JSX } from 'react';

export interface IndicatorGlyphProps {
	/** Codicon name, e.g. `warning` → `codicon-warning`. */
	icon: string;
	/** The one-hover phrase naming what this indicator means. */
	meaning: string;
	/** Extra classes (state colour, `card-status-icon`, …). */
	className?: string;
}

export function IndicatorGlyph({ icon, meaning, className }: IndicatorGlyphProps): JSX.Element {
	return (
		<span
			className={`codicon codicon-${icon} tip${className ? ` ${className}` : ''}`}
			data-tip={meaning}
			aria-label={meaning}
			role="img"
		/>
	);
}

/**
 * The accent bar's meaning (design/05-ui.md rule 6). The bar itself is a 3px
 * pseudo-element with no DOM node to hover, so this widens its left-edge gutter
 * into a hover target carrying the same DOM tooltip.
 */
export function AccentTip({ meaning }: { meaning: string }): JSX.Element {
	return <span className="accent-tip tip" data-tip={meaning} aria-label={meaning} role="img" />;
}
