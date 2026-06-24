/**
 * Root webview component: holds the latest DisplayState snapshot (no state
 * library — snapshots ARE the store) and renders tray or editor layout.
 */

import { createContext, useContext, useEffect, useMemo, useState, type JSX } from 'react';

import { ExtensionMessage, ViewMode, WebviewMessage } from '../../host/webviewTypes';
import { CardDisplay, DisplayState } from '../../queue/displayTypes';
import { AgentsStrip } from './AgentsStrip';
import { DetailPane } from './DetailPane';
import { Header } from './Header';
import { LaneSection } from './LaneSection';

export const PostContext = createContext<(message: WebviewMessage) => void>(() => undefined);
export const usePost = (): ((message: WebviewMessage) => void) => useContext(PostContext);

/** Repo-badge click target: filter the queue to one repo (design/05 click table). */
export const RepoFilterContext = createContext<(repoRoot: string) => void>(() => undefined);
export const useRepoFilter = (): ((repoRoot: string) => void) => useContext(RepoFilterContext);

export interface QueueAppProps {
	postMessage: (message: WebviewMessage) => void;
	subscribeMessages: (handler: (message: ExtensionMessage) => void) => () => void;
}

export interface ViewOptions {
	filter: string;
	repoFilter: string | null;
	showDone: boolean;
	groupByRepo: boolean;
}

const DEFAULT_OPTIONS: ViewOptions = { filter: '', repoFilter: null, showDone: false, groupByRepo: false };

export function QueueApp({ postMessage, subscribeMessages }: QueueAppProps): JSX.Element {
	const [mode, setMode] = useState<ViewMode>('tray');
	const [state, setState] = useState<DisplayState | null>(null);
	const [options, setOptions] = useState<ViewOptions>(DEFAULT_OPTIONS);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	useEffect(() => {
		const unsubscribe = subscribeMessages((message) => {
			if (message.type === 'init') setMode(message.mode);
			if (message.type === 'displayState') setState(message.state);
		});
		postMessage({ type: 'ready' });
		return unsubscribe;
	}, [postMessage, subscribeMessages]);

	const cards = useMemo(() => filterCards(state, options), [state, options]);

	// Selection honesty (design/05 "Editor tab"): when the queue updates under a
	// selection whose card has left the visible set, clear it — never let it
	// silently re-point to an unrelated card. Gate on `state` so a not-yet-loaded
	// snapshot (empty `cards`) can't wipe a selection before the first state lands.
	useEffect(() => {
		if (state && selectedId !== null && !cards.some((c) => c.id === selectedId)) setSelectedId(null);
	}, [state, cards, selectedId]);

	if (!state) return <div className="lane-empty">Loading…</div>;
	const body =
		mode === 'editor' ? (
			<EditorBody state={state} cards={cards} selectedId={selectedId} onSelect={setSelectedId} />
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

/**
 * Resolve what the right pane shows (design/05 "Editor tab"): an `explicit`
 * selection wins; otherwise the top NEEDS-YOU item is the `implicit` fallback,
 * which the pane must label so it never reads as authoritative.
 */
function resolveSelection(
	cards: CardDisplay[],
	selectedId: string | null,
): { explicit: CardDisplay | null; implicit: CardDisplay | null } {
	const explicit = selectedId !== null ? (cards.find((c) => c.id === selectedId) ?? null) : null;
	if (explicit) return { explicit, implicit: null };
	return { explicit: null, implicit: cards.find((c) => c.lane === 'needs-you') ?? cards[0] ?? null };
}

export function EditorBody({ state, cards, selectedId, onSelect }: LanesProps): JSX.Element {
	const { explicit, implicit } = resolveSelection(cards, selectedId);
	const shown = explicit ?? implicit;
	return (
		<div className="editor-layout">
			<div className="editor-list">
				{/* Highlight the list only for an explicit selection — the implicit
				    fallback must not look chosen. */}
				<Lanes state={state} cards={cards} selectedId={explicit?.id ?? null} onSelect={onSelect} />
			</div>
			<div className="editor-detail">
				{implicit && <div className="selection-note">most urgent — nothing selected</div>}
				{shown ? <DetailPane card={shown} state={state} /> : <div className="lane-empty">Select an item</div>}
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
