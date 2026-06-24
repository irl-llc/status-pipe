/**
 * Root webview component: holds the latest DisplayState snapshot (no state
 * library — snapshots ARE the store) and renders tray or editor layout.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type JSX } from 'react';

import { ExtensionMessage, ViewMode, WebviewMessage } from '../../host/webviewTypes';
import { CardDisplay, DisplayState } from '../../queue/displayTypes';
import { clampEditorListWidth, readEditorListWidth, type UiState } from '../uiState';
import { AgentsStrip } from './AgentsStrip';
import { DetailPane } from './DetailPane';
import { Header } from './Header';
import { LaneSection } from './LaneSection';
import { Splitter } from './Splitter';

export const PostContext = createContext<(message: WebviewMessage) => void>(() => undefined);
export const usePost = (): ((message: WebviewMessage) => void) => useContext(PostContext);

/** Repo-badge click target: filter the queue to one repo (design/05 click table). */
export const RepoFilterContext = createContext<(repoRoot: string) => void>(() => undefined);
export const useRepoFilter = (): ((repoRoot: string) => void) => useContext(RepoFilterContext);

export interface QueueAppProps {
	postMessage: (message: WebviewMessage) => void;
	subscribeMessages: (handler: (message: ExtensionMessage) => void) => () => void;
	getUiState?: () => unknown;
	setUiState?: (state: unknown) => void;
}

export interface ViewOptions {
	filter: string;
	repoFilter: string | null;
	showDone: boolean;
	groupByRepo: boolean;
}

const DEFAULT_OPTIONS: ViewOptions = { filter: '', repoFilter: null, showDone: false, groupByRepo: false };

export function QueueApp({ postMessage, subscribeMessages, getUiState, setUiState }: QueueAppProps): JSX.Element {
	const [mode, setMode] = useState<ViewMode>('tray');
	const [state, setState] = useState<DisplayState | null>(null);
	const [options, setOptions] = useState<ViewOptions>(DEFAULT_OPTIONS);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [editorListWidth, setEditorListWidth] = useState<number>(() => readEditorListWidth(getUiState?.()));

	const onResizeList = useCallback(
		(width: number): void => {
			const clamped = clampEditorListWidth(width);
			setEditorListWidth(clamped);
			const next: UiState = { ...((getUiState?.() as Partial<UiState>) ?? {}), editorListWidth: clamped };
			setUiState?.(next);
		},
		[getUiState, setUiState],
	);

	useEffect(() => {
		const unsubscribe = subscribeMessages((message) => {
			if (message.type === 'init') setMode(message.mode);
			if (message.type === 'displayState') setState(message.state);
		});
		postMessage({ type: 'ready' });
		return unsubscribe;
	}, [postMessage, subscribeMessages]);

	const cards = useMemo(() => filterCards(state, options), [state, options]);

	if (!state) return <div className="lane-empty">Loading…</div>;
	const body =
		mode === 'editor' ? (
			<EditorBody
				state={state}
				cards={cards}
				selectedId={selectedId}
				onSelect={setSelectedId}
				options={options}
				listWidth={editorListWidth}
				onResizeList={onResizeList}
			/>
		) : (
			<Lanes state={state} cards={cards} selectedId={selectedId} onSelect={setSelectedId} />
		);
	return (
		<PostContext.Provider value={postMessage}>
			<RepoFilterContext.Provider value={(repoRoot) => setOptions({ ...options, repoFilter: repoRoot })}>
				<div className="queue-app">
					<Header state={state} options={options} onOptions={setOptions} />
					<AgentsStrip state={state} />
					{options.repoFilter && (
						<div className="monitor-note">
							filtered to {shortName(options.repoFilter)} ·{' '}
							<a href="#" onClick={() => setOptions({ ...options, repoFilter: null })}>
								clear
							</a>
						</div>
					)}
					{state.repos.map(
						(r) =>
							r.monitorOnlyNote && (
								<div key={r.repoRoot} className="monitor-note">
									{r.monitorOnlyNote}
								</div>
							),
					)}
					{body}
				</div>
			</RepoFilterContext.Provider>
		</PostContext.Provider>
	);
}

interface LanesProps {
	state: DisplayState;
	cards: CardDisplay[];
	selectedId: string | null;
	onSelect: (id: string | null) => void;
}

function Lanes({ state, cards, selectedId, onSelect }: LanesProps): JSX.Element {
	return (
		<div className="lanes">
			<LaneSection
				lane="needs-you"
				title="NEEDS YOU"
				cards={cards.filter((c) => c.lane === 'needs-you')}
				state={state}
				selectedId={selectedId}
				onSelect={onSelect}
			/>
			<LaneSection
				lane="waiting"
				title="WAITING ON WORLD"
				cards={cards.filter((c) => c.lane === 'waiting')}
				state={state}
				selectedId={selectedId}
				onSelect={onSelect}
			/>
			<LaneSection
				lane="quiet"
				title="QUIET"
				cards={cards.filter((c) => c.lane === 'quiet')}
				state={state}
				selectedId={selectedId}
				onSelect={onSelect}
				collapsedByDefault
			/>
		</div>
	);
}

interface EditorBodyProps extends LanesProps {
	options: ViewOptions;
	listWidth: number;
	onResizeList: (width: number) => void;
}

function EditorBody({ state, cards, selectedId, onSelect, listWidth, onResizeList }: EditorBodyProps): JSX.Element {
	const selected = cards.find((c) => c.id === selectedId) ?? cards[0] ?? null;
	return (
		<div className="editor-layout">
			<div className="editor-list" style={{ width: `${listWidth}px` }}>
				<Lanes state={state} cards={cards} selectedId={selected?.id ?? null} onSelect={onSelect} />
			</div>
			<Splitter width={listWidth} onResize={onResizeList} />
			<div className="editor-detail">
				{selected ? <DetailPane card={selected} state={state} /> : <div className="lane-empty">Select an item</div>}
			</div>
		</div>
	);
}

function filterCards(state: DisplayState | null, options: ViewOptions): CardDisplay[] {
	if (!state) return [];
	const needle = options.filter.toLowerCase();
	return state.cards.filter((card) => {
		if (options.repoFilter && card.repoRoot !== options.repoFilter) return false;
		if (card.lane === 'quiet' && card.hiddenByDefault && !options.showDone) return false;
		if (!needle) return true;
		const haystack = `${card.ticket ?? ''} ${card.title} ${card.headline} ${card.repoName}`.toLowerCase();
		return haystack.includes(needle);
	});
}

function shortName(repoRoot: string): string {
	return repoRoot.split('/').pop() ?? repoRoot;
}
