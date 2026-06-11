/**
 * Unit tests for releaseBump.ts — the scheduled auto-release semver derivation.
 */

import * as assert from 'assert';

import {
	applyBump,
	deriveBumpLevel,
	deriveNextVersion,
	formatSemVer,
	KIND_BUMP,
	parseSemVer,
} from '../../../utils/releaseBump';

describe('releaseBump', () => {
	describe('parseSemVer / formatSemVer', () => {
		it('round-trips a major.minor.patch version', () => {
			assert.strictEqual(formatSemVer(parseSemVer('0.0.4')), '0.0.4');
			assert.deepStrictEqual(parseSemVer(' 1.2.3 '), { major: 1, minor: 2, patch: 3 });
		});

		it('throws on a non-semver string', () => {
			assert.throws(() => parseSemVer('0.0'), /not a major\.minor\.patch version/);
			assert.throws(() => parseSemVer('v0.0.4'), /not a major\.minor\.patch version/);
		});
	});

	describe('deriveBumpLevel', () => {
		it('returns none for no pending kinds', () => {
			assert.strictEqual(deriveBumpLevel([]), 'none');
		});

		it('maps Fixed/Security to patch', () => {
			assert.strictEqual(deriveBumpLevel(['Fixed']), 'patch');
			assert.strictEqual(deriveBumpLevel(['Security']), 'patch');
			assert.strictEqual(deriveBumpLevel(['Fixed', 'Security']), 'patch');
		});

		it('maps Added/Changed/Removed/Deprecated to minor', () => {
			assert.strictEqual(deriveBumpLevel(['Added']), 'minor');
			assert.strictEqual(deriveBumpLevel(['Changed']), 'minor');
			assert.strictEqual(deriveBumpLevel(['Removed']), 'minor');
			assert.strictEqual(deriveBumpLevel(['Deprecated']), 'minor');
		});

		it('lets a single minor kind win over many patch kinds', () => {
			assert.strictEqual(deriveBumpLevel(['Fixed', 'Security', 'Added', 'Fixed']), 'minor');
		});

		it('ignores unknown kinds (never escalates on a typo)', () => {
			assert.strictEqual(deriveBumpLevel(['Bogus']), 'none');
			assert.strictEqual(deriveBumpLevel(['Bogus', 'Fixed']), 'patch');
		});
	});

	describe('applyBump (0.x semantics)', () => {
		it('bumps minor and resets patch', () => {
			assert.strictEqual(formatSemVer(applyBump(parseSemVer('0.0.4'), 'minor')), '0.1.0');
			assert.strictEqual(formatSemVer(applyBump(parseSemVer('0.3.7'), 'minor')), '0.4.0');
		});

		it('bumps patch in place', () => {
			assert.strictEqual(formatSemVer(applyBump(parseSemVer('0.0.4'), 'patch')), '0.0.5');
		});

		it('never bumps major while on 0.x', () => {
			const next = applyBump(parseSemVer('0.9.9'), 'minor');
			assert.strictEqual(next.major, 0);
			assert.strictEqual(formatSemVer(next), '0.10.0');
		});

		it('leaves the version unchanged for none', () => {
			assert.strictEqual(formatSemVer(applyBump(parseSemVer('0.0.4'), 'none')), '0.0.4');
		});
	});

	describe('deriveNextVersion', () => {
		it('returns null next version when nothing is pending', () => {
			assert.deepStrictEqual(deriveNextVersion('0.0.4', []), { level: 'none', nextVersion: null });
		});

		it('derives a minor release from a feature fragment', () => {
			assert.deepStrictEqual(deriveNextVersion('0.0.4', ['Added']), {
				level: 'minor',
				nextVersion: '0.1.0',
			});
		});

		it('derives a patch release from only bug fixes', () => {
			assert.deepStrictEqual(deriveNextVersion('0.0.4', ['Fixed', 'Fixed']), {
				level: 'patch',
				nextVersion: '0.0.5',
			});
		});
	});

	describe('KIND_BUMP matches .changie.yaml auto levels', () => {
		it('covers exactly the kinds defined in the config', () => {
			assert.deepStrictEqual(Object.keys(KIND_BUMP).sort(), [
				'Added',
				'Changed',
				'Deprecated',
				'Fixed',
				'Removed',
				'Security',
			]);
		});
	});
});
