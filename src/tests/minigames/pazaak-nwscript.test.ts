import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/module/ModuleCreature', () => ({ ModuleCreature: class {} }));
jest.mock('@/loaders', () => ({ ResourceLoader: {} }));
jest.mock('@/audio/AudioEngine', () => ({ AudioEngine: {} }));
jest.mock('@/engine/EngineLocation', () => ({ __esModule: true, default: class {} }));
jest.mock('@/resource/GFFObject', () => ({ GFFObject: class {} }));

import { GameState } from '@/GameState';
import { PazaakManager } from '@/managers/PazaakManager';
import { GetLastPazaakResult, PlayPazaak } from '@/nwscript/builtins/objects/minigame';
import { PazaakConfig as K1Config } from '@/game/kotor/minigames/mg-pazaak-config';

const state = GameState as any;
const PM = PazaakManager;

function finishMatch(playerWins: boolean){
  PM.Config = K1Config as any;
  PM.BeginGame();
  PM.Actions = [];
  PM.Tables[0].winCount = playerWins ? 2 : 0;
  PM.Tables[1].winCount = playerWins ? 0 : 2;
  // Final round: player 19 vs opponent 18, or the reverse
  for(let i = 0; i < 9; i++){
    PM.Tables[0].cardArea.set(i, undefined);
    PM.Tables[1].cardArea.set(i, undefined);
  }
  const card = (v: number) => ({ ...K1Config.data.mainDeckCards[v - 1], value: v });
  PM.Tables[0].cardArea.set(0, card(10));
  PM.Tables[0].cardArea.set(1, card(playerWins ? 9 : 8));
  PM.Tables[1].cardArea.set(0, card(10));
  PM.Tables[1].cardArea.set(1, card(playerWins ? 8 : 9));
  PM.Tables[0].points = playerWins ? 19 : 18;
  PM.Tables[1].points = playerWins ? 18 : 19;
  PM.AddAction(0, 7 /* END_ROUND */);
  let n = 0;
  while(PM.Actions.length && n++ < 100) PM.ProcessActionQueue(10);
}

beforeEach(() => {
  state.PartyManager = { Player: { addGold: jest.fn() } };
  state.MenuManager = {
    MenuPazaakGame: { close: jest.fn() },
    MenuPazaakSetup: { open: jest.fn() },
    InGameConfirm: { fromStringRef: jest.fn() },
  };
  state.guiAudioEmitter = { playSoundFireAndForget: jest.fn() };
  state.PazaakManager = PazaakManager;
  state.SWRuleSet = { pazaakDecks: [{ cards: Array(10).fill(0) }] };
  state.NWScript = { Load: jest.fn(() => undefined) };
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('Pazaak nwscript routines', () => {
  test('PlayPazaak resets the last result; GetLastPazaakResult reports 1 on a win', () => {
    (PlayPazaak.kotor as any).call({ caller: {} }, 0, 'k_end', 50, 0, undefined);
    expect(PM.Wager).toBe(50);
    expect((GetLastPazaakResult.kotor as any).call({})).toBe(0);
    finishMatch(true);
    expect(PM.Won).toBe(true);
    expect((GetLastPazaakResult.kotor as any).call({})).toBe(1);
    expect(state.PartyManager.Player.addGold).toHaveBeenCalledWith(50);
  });

  test('GetLastPazaakResult reports 0 on a loss', () => {
    (PlayPazaak.kotor as any).call({ caller: {} }, 0, 'k_end', 50, 0, undefined);
    finishMatch(false);
    expect(PM.Won).toBe(false);
    expect((GetLastPazaakResult.kotor as any).call({})).toBe(0);
    expect(state.PartyManager.Player.addGold).toHaveBeenCalledWith(-50);
  });
});
