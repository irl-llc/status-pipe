/**
 * Forge resolution (design/03-forge.md): explicit type override wins
 * unconditionally (matchRemoteUrl is then only used to parse the slug);
 * otherwise the first registry entry matching the remote URL. No match →
 * the repo renders unenriched ("enrichment off: unrecognized forge").
 */

import { parseRemote } from './remote';
import { Forge, RepositoryId } from './types';

export interface ResolvedForge {
	forge: Forge;
	id: RepositoryId;
}

export type ForgeTypeOverride = 'auto' | string;

export function resolveForge(
	forges: Forge[],
	remoteUrl: string | null,
	override: ForgeTypeOverride,
): ResolvedForge | null {
	if (!remoteUrl) return null;
	if (override !== 'auto') return resolveExplicit(forges, remoteUrl, override);
	for (const forge of forges) {
		const id = forge.matchRemoteUrl(remoteUrl);
		if (id) return { forge, id };
	}
	return null;
}

interface SlugForge extends Forge {
	repositoryId(slug: string): RepositoryId;
}

function hasRepositoryId(forge: Forge): forge is SlugForge {
	return typeof (forge as SlugForge).repositoryId === 'function';
}

function resolveExplicit(forges: Forge[], remoteUrl: string, forgeId: string): ResolvedForge | null {
	const forge = forges.find((f) => f.id === forgeId);
	if (!forge) return null;
	// Prefer the forge's own host-aware match (parses GHE-style URLs too)…
	const matched = forge.matchRemoteUrl(remoteUrl);
	if (matched) return { forge, id: matched };
	// …but with an explicit override the host needn't match: parse the slug.
	const remote = parseRemote(remoteUrl);
	if (!remote || !hasRepositoryId(forge)) return null;
	return { forge, id: forge.repositoryId(remote.slug) };
}
