import { beforeAll, describe, expect, test } from '@jest/globals';
import { harness } from './routineHarness';

/**
 * TSL inherits K1 routine bodies by NAME, never by colliding id. The two tables
 * agree on every shared id except 768-771, where TSL inserted its own routines
 * and K1's continue at other ids (K1 770 PlayMovieQueue is TSL 807).
 *
 * This runs against the real runtime tables (buildReconciledActionMap through
 * NWScriptDefK1/K2), not against a parse of the table source: the source files
 * are now stubs that build the tables at load time, so a source parse would
 * see nothing.
 */
let runtime: ReturnType<typeof harness>;
let isEngineRoutineFallback: (action: unknown) => boolean;

beforeAll(() => {
  runtime = harness();
  ({ isEngineRoutineFallback } = runtime.loadScript('engineRoutineFallbacks'));
});

const ids = (table: Record<number, unknown>) => Object.keys(table).map(Number);
const hasBody = (action: any) => typeof action?.action === 'function' && !isEngineRoutineFallback(action);

describe('K1 and TSL routine tables', () => {
  test('disagree on the names of exactly ids 768-771', () => {
    const { kotor, tsl } = runtime;
    expect(ids(kotor).length).toBeGreaterThan(700);
    expect(ids(tsl).length).toBeGreaterThan(800);
    const differing = ids(tsl).filter((id) => kotor[id] && kotor[id].name !== tsl[id].name);
    expect(differing.sort((a, b) => a - b)).toEqual([768, 769, 770, 771]);
  });

  test('TSL 770 is its own EffectForceBody, not K1 PlayMovieQueue at the colliding id', () => {
    expect(runtime.kotor[770].name).toBe('PlayMovieQueue');
    expect(runtime.tsl[770].name).toBe('EffectForceBody');
    expect(runtime.tsl[770].action).not.toBe(runtime.kotor[770].action);
  });

  test('TSL 807 PlayMovieQueue has a real body', () => {
    expect(runtime.tsl[807].name).toBe('PlayMovieQueue');
    expect(hasBody(runtime.tsl[807])).toBe(true);
  });

  test('every TSL routine whose K1 namesake at the same id has a body has one too', () => {
    const { kotor, tsl } = runtime;
    const missing = ids(tsl).filter((id) =>
      kotor[id] && kotor[id].name === tsl[id].name && hasBody(kotor[id]) && !hasBody(tsl[id]));
    expect(missing).toEqual([]);
  });
});
