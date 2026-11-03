import { beforeEach, describe, expect, jest, test } from '@jest/globals';

/**
 * MenuManager builds the game-over and credits menus on first use (not in the
 * LoadInGameMenus Promise.all, where one missing GUI would take every in-game
 * menu down). Each must be the current game's class and be built only once.
 */

const built: string[] = [];
function menuClass(name: string) {
  return class {
    manager: any;
    constructor() { built.push(name); }
    // A GUI load takes real time; callers can overlap it.
    async load() { await new Promise((resolve) => setImmediate(resolve)); return this; }
  };
}

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/game/kotor/KOTOR', () => ({ MenuGameOver: menuClass('K1.MenuGameOver'), MenuCredits: menuClass('K1.MenuCredits') }));
jest.mock('@/game/tsl/TSL', () => ({ MenuGameOver: menuClass('TSL.MenuGameOver'), MenuCredits: menuClass('TSL.MenuCredits') }));
jest.mock('@/engine/menu/ActionMenuManager', () => ({ ActionMenuManager: {} }));
jest.mock('@/utility/PerformanceMonitor', () => ({ PerformanceMonitor: { start() {}, stop() {} } }));
jest.mock('@/managers/EventManager', () => ({ EventManager: { FireEvent() {} } }));

import { GameState } from '@/GameState';
import { MenuManager } from '@/managers/MenuManager';
import { GameEngineType } from '@/enums/engine/GameEngineType';

const state = GameState as any;

beforeEach(() => {
  built.length = 0;
  MenuManager.MenuGameOver = undefined;
  MenuManager.MenuCredits = undefined;
});

describe.each([
  [GameEngineType.KOTOR, 'K1'],
  [GameEngineType.TSL, 'TSL'],
])('game %s', (gameKey, prefix) => {
  test('the game-over menu is the game\'s own class, built once', async () => {
    state.GameKey = gameKey;
    const first = await MenuManager.GetMenuGameOver();
    const second = await MenuManager.GetMenuGameOver();
    expect(second).toBe(first);
    expect((first as any).manager).toBe(MenuManager);
    expect(built).toEqual([`${prefix}.MenuGameOver`]);
  });

  test('the credits menu is the game\'s own class, built once', async () => {
    state.GameKey = gameKey;
    const first = await MenuManager.GetMenuCredits();
    expect(await MenuManager.GetMenuCredits()).toBe(first);
    expect(built).toEqual([`${prefix}.MenuCredits`]);
  });

  test('callers that overlap the first build share it (two StartCreditSequence / death-screen calls)', async () => {
    state.GameKey = gameKey;
    const [creditsA, creditsB] = await Promise.all([MenuManager.GetMenuCredits(), MenuManager.GetMenuCredits()]);
    const [overA, overB] = await Promise.all([MenuManager.GetMenuGameOver(), MenuManager.GetMenuGameOver()]);
    expect(creditsB).toBe(creditsA);
    expect(MenuManager.MenuCredits).toBe(creditsA);
    expect(overB).toBe(overA);
    expect(built).toEqual([`${prefix}.MenuCredits`, `${prefix}.MenuGameOver`]);
  });
});
