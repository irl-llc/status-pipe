/**
 * Unit tests for queueView/uiState.ts — editor pane width clamping and the
 * persisted-blob reader (vscode-free).
 */

import assert from 'node:assert/strict';

import {
	clampEditorListWidth,
	DEFAULT_EDITOR_LIST_WIDTH,
	MAX_EDITOR_LIST_WIDTH,
	MIN_EDITOR_LIST_WIDTH,
	readEditorListWidth,
} from '../../../queueView/uiState';

describe('queueView/uiState', () => {
	describe('clampEditorListWidth', () => {
		it('passes through an in-range width, rounded', () => {
			assert.equal(clampEditorListWidth(400.6), 401);
		});
		it('clamps below the minimum', () => {
			assert.equal(clampEditorListWidth(10), MIN_EDITOR_LIST_WIDTH);
		});
		it('clamps above the maximum', () => {
			assert.equal(clampEditorListWidth(9999), MAX_EDITOR_LIST_WIDTH);
		});
		it('falls back to the default on non-finite input', () => {
			assert.equal(clampEditorListWidth(Number.NaN), DEFAULT_EDITOR_LIST_WIDTH);
			assert.equal(clampEditorListWidth(Infinity), DEFAULT_EDITOR_LIST_WIDTH);
		});
	});

	describe('readEditorListWidth', () => {
		it('returns the default when no state is stored', () => {
			assert.equal(readEditorListWidth(null), DEFAULT_EDITOR_LIST_WIDTH);
			assert.equal(readEditorListWidth(undefined), DEFAULT_EDITOR_LIST_WIDTH);
			assert.equal(readEditorListWidth({}), DEFAULT_EDITOR_LIST_WIDTH);
		});
		it('reads and clamps a stored width', () => {
			assert.equal(readEditorListWidth({ editorListWidth: 420 }), 420);
			assert.equal(readEditorListWidth({ editorListWidth: 5 }), MIN_EDITOR_LIST_WIDTH);
		});
		it('ignores a non-numeric stored width', () => {
			assert.equal(readEditorListWidth({ editorListWidth: 'wide' }), DEFAULT_EDITOR_LIST_WIDTH);
		});
	});
});
