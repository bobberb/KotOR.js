import { afterEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/loaders', () => ({ TextureLoader: {}, ResourceLoader: {} }));
jest.mock('@/KotOR', () => ({ ResourceTypes: {} }));
jest.mock('@/resource/ERFObject', () => ({ ERFObject: class {} }));
jest.mock('@/managers/TLKManager', () => ({ TLKManager: { GetStringById: (): undefined => undefined } }));
jest.mock('@/utility/GameFileSystem', () => ({
  GameFileSystem: {
    readFile: jest.fn(async () => new Uint8Array()),
    readdir: jest.fn(async () => []),
    exists: jest.fn(async () => false),
    mkdir: jest.fn(async () => true),
    writeFile: jest.fn(async () => true),
  },
}));

import { SaveGame } from '@/engine/SaveGame';
import { GameState } from '@/GameState';
import { GameFileSystem } from '@/utility/GameFileSystem';
import { EngineMode } from '@/enums/engine/EngineMode';

const state = GameState as any;

afterEach(() => {
  state.module = undefined;
  state.Mode = undefined;
  jest.clearAllMocks();
});

/**
 * Mid-minigame save/load is unsupported by design (minigame runtime state is not
 * serialized). The fail-safe is that no save can be taken inside a minigame, so a
 * save never captures a half-run race/turret fight, and nothing is written.
 */
describe('minigame save fail-safe', () => {
  test('no save while the area has a minigame, in either engine mode', async () => {
    state.module = { area: { miniGame: {} } };
    for (const mode of [EngineMode.MINIGAME, EngineMode.INGAME]) {
      state.Mode = mode;
      expect(SaveGame.CanSaveCurrentGame()).toBe(false);
      expect(await SaveGame.SaveCurrentGame('mid race')).toBe(false);
      expect(await new SaveGame('000002 - mid race').Save()).toBe(false);
    }
    expect(GameFileSystem.writeFile).not.toHaveBeenCalled();
    expect(GameFileSystem.mkdir).not.toHaveBeenCalled();
  });

  test('saving is allowed again once the area has no minigame', () => {
    state.module = { area: {} };
    state.Mode = EngineMode.INGAME;
    expect(SaveGame.CanSaveCurrentGame()).toBe(true);
  });
});
