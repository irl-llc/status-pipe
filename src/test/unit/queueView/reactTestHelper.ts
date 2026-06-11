/**
 * JSDOM environment for @testing-library/react component tests, following
 * the reactTestHelper pattern from git-spice-code-extension.
 *
 * Holds ONE long-lived JSDOM instance for the whole mocha process (closed
 * JSDOMs can never be reused) and re-binds globalThis to it per test.
 *
 * Why a top-level side-effect: @testing-library/dom captures references at
 * import time, so real globals must exist before its import runs.
 *
 * Usage:
 *
 *     import { installJsdomGlobals } from './reactTestHelper'; // FIRST import
 *     import { render } from '@testing-library/react';
 *     // …
 *     beforeEach(installJsdomGlobals);
 */

// jsdom's bundled type declarations do not resolve under this tsconfig's
// node10 moduleResolution (parse5 depends on the `entities/decode` subpath
// export, which needs node16/bundler resolution). Importing the module
// type-free keeps `tsc -p .` green; we declare just the surface we use.
interface JsdomLike {
	window: { document: Document } & Record<string, unknown>;
}

interface JsdomConstructor {
	new (html: string, options?: { url?: string; pretendToBeVisual?: boolean }): JsdomLike;
}

const { JSDOM } = require('jsdom') as { JSDOM: JsdomConstructor };

let dom: JsdomLike | undefined;

/** Returns the singleton JSDOM, creating it on first call. */
function getDom(): JsdomLike {
	if (!dom) {
		dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
			url: 'http://localhost/',
			pretendToBeVisual: true,
		});
		copyConstructorsToGlobalThis(dom);
	}
	return dom;
}

/** Copies window properties that aren't already on globalThis (one-time). */
function copyConstructorsToGlobalThis(jsdom: JsdomLike): void {
	const g = globalThis as Record<string, unknown>;
	const w = jsdom.window as Record<string, unknown>;
	for (const key of Object.getOwnPropertyNames(jsdom.window)) {
		if (key in g) continue;
		try {
			g[key] = w[key];
		} catch {
			// Read-only globals — skip.
		}
	}
}

/**
 * (Re-)binds globalThis.window/document/navigator to the singleton JSDOM
 * and clears document.body. Safe to call repeatedly.
 */
export function installJsdomGlobals(): void {
	const jsdom = getDom();
	const g = globalThis as Record<string, unknown>;
	g.window = jsdom.window;
	g.document = jsdom.window.document;
	g.IS_REACT_ACT_ENVIRONMENT = true;
	jsdom.window.document.body.innerHTML = '';
}

// Run once at module load so testing-library's import-time captures find a
// real document.
installJsdomGlobals();
