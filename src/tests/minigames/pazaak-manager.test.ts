import { beforeEach, afterEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/module/ModuleCreature', () => ({ ModuleCreature: class {} }));

import { GameState } from '@/GameState';
import { PazaakManager } from '@/managers/PazaakManager';
import { PazaakCards } from '@/enums/minigames/PazaakCards';
import { PazaakTurnMode } from '@/enums/minigames/PazaakTurnMode';
import { PazaakRoundResult } from '@/engine/minigames/PazaakRules';
import { PazaakConfig as K1Config } from '@/game/kotor/minigames/mg-pazaak-config';
import { PazaakConfig as TSLConfig } from '@/game/tsl/minigames/mg-pazaak-config';

const state = GameState as any;
const PM = PazaakManager;
const P = PazaakTurnMode.PLAYER;
const O = PazaakTurnMode.OPPONENT;

let addGold: jest.Mock;
let roundDecks: number[][];

/**
 * Each round's main deck is scripted: draws happen in the listed order,
 * player first, alternating while neither side stands.
 */
function scriptRounds(...draws: number[][]){
  roundDecks = draws.map((d) => d.slice());
}

/** Run the queue until it waits for player input (empty queue). */
function runUntilInput(maxSteps = 2000){
  let steps = 0;
  while(PM.Actions.length && steps++ < maxSteps){
    PM.ProcessActionQueue(10);
  }
  if(PM.Actions.length) throw new Error(`queue did not settle: ${PM.Actions.map((a) => a.type).join(',')}`);
}

function setHand(tableIndex: number, cards: PazaakCards[]){
  for(let i = 0; i < 4; i++){
    PM.Tables[tableIndex].handCards.set(i, cards[i] ?? PazaakCards.INVALID);
  }
}

function beginMatch(config: any, playerHand: PazaakCards[] = [], opponentHand: PazaakCards[] = []){
  PM.Config = config;
  PM.BeginGame();
  setHand(P, playerHand);
  setHand(O, opponentHand);
  runUntilInput();
}

const endTurn = () => { PM.AddEndTurnAction(P); runUntilInput(); };
const stand = () => { PM.AddStandAction(P); runUntilInput(); };
const playCard = (hand: number, flipped = false) => { PM.AddPlayHandCardAction(P, hand, flipped); runUntilInput(); };

beforeEach(() => {
  addGold = jest.fn();
  state.PartyManager = { Player: { addGold } };
  state.MenuManager = {
    MenuPazaakGame: { close: jest.fn() },
    InGameConfirm: { fromStringRef: jest.fn() },
  };
  state.guiAudioEmitter = { playSoundFireAndForget: jest.fn() };
  state.GameKey = undefined;
  roundDecks = [];
  jest.spyOn(PM, 'ResetMainDeck').mockImplementation(() => {
    // Unscripted draws are 1s so play past the scripted part stays deterministic
    const next = roundDecks.shift() ?? Array(40).fill(1);
    // DrawMainDeckValue pops from the end
    PM.MainDeck = next.slice().reverse();
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  PM.Wager = 100;
  PM.EndScriptInstance = undefined;
});

afterEach(() => jest.restoreAllMocks());

describe('PazaakManager rules in play', () => {
  test('a minus card played after the draw rescues a bust', () => {
    // P10 O3 P8(18) O4 P7(25) ... O10 O10 (opponent busts behind the standing player)
    scriptRounds([10, 3, 8, 4, 7, 10, 10]);
    beginMatch(K1Config, [PazaakCards.MINUS_5]);
    endTurn();
    endTurn();
    expect(PM.Tables[P].points).toBe(25);
    // still the player's turn: the bust is not decided at the draw
    expect(PM.TurnMode).toBe(P);
    expect(PM.Tables[O].winCount).toBe(0);

    playCard(0);
    expect(PM.Tables[P].points).toBe(20);
    expect(PM.Tables[P].handCards.get(0)).toBe(PazaakCards.INVALID);
    // 20 at end of turn stands automatically
    endTurn();
    expect(PM.Tables[O].winCount).toBe(0);
    expect(PM.Tables[P].winCount).toBe(1);
  });

  test('over 20 with no hand card left busts at end of turn', () => {
    // P10 O2 P5 O2 P9(24): no hand cards, so the turn ends itself
    scriptRounds([10, 2, 5, 2, 9], [1]);
    beginMatch(K1Config);
    endTurn();
    endTurn();
    expect(PM.Tables[O].winCount).toBe(1);
    expect(PM.LastRoundResult).toBe(PazaakRoundResult.OPPONENT);
  });

  test('nine cards without busting wins the round outright', () => {
    // opponent reaches 20 and stands; player then fills nine cards at 17
    scriptRounds([2, 10, 2, 10, 2, 2, 2, 2, 2, 2, 1], [1]);
    beginMatch(K1Config);
    for(let i = 0; i < 8; i++){
      endTurn();
    }
    expect(PM.Tables[P].winCount).toBe(1);
    expect(PM.Tables[O].winCount).toBe(0);
    expect(PM.LastRoundResult).toBe(PazaakRoundResult.PLAYER);
  });

  test('a tied round awards nobody and replays', () => {
    // P10 O10 P9 -> player stands on 19, AI draws 9 -> 19 and takes the tie
    scriptRounds([10, 10, 9, 9], [1]);
    beginMatch(K1Config);
    endTurn();
    stand();
    expect(PM.LastRoundResult).toBe(PazaakRoundResult.TIE);
    expect(PM.Tables[P].winCount).toBe(0);
    expect(PM.Tables[O].winCount).toBe(0);
    // next round started (scripted deck [1] drawn by the player)
    expect(PM.Tables[P].points).toBe(1);
  });

  test('TSL tiebreaker card wins a tie', () => {
    scriptRounds([10, 10, 8, 9], [1]);
    beginMatch(TSLConfig, [PazaakCards.TSL_TIEBREAKER]);
    endTurn();
    playCard(0);
    expect(PM.Tables[P].points).toBe(19);
    stand();
    expect(PM.LastRoundResult).toBe(PazaakRoundResult.PLAYER);
    expect(PM.Tables[P].winCount).toBe(1);
  });

  test('TSL flip 2&4 rewrites table cards and the score', () => {
    scriptRounds([2, 1, 4, 1, 10]);
    beginMatch(TSLConfig, [PazaakCards.TSL_FLIP_2_4]);
    endTurn();
    endTurn();
    expect(PM.Tables[P].points).toBe(16);
    playCard(0);
    expect(PM.Tables[P].points).toBe(4);
    expect(PM.GetTableValues(P)).toEqual([-2, -4, 10, 0]);
  });

  test('TSL double card doubles the last table card', () => {
    scriptRounds([10, 3, 5]);
    beginMatch(TSLConfig, [PazaakCards.TSL_DOUBLE]);
    endTurn();
    expect(PM.Tables[P].points).toBe(15);
    playCard(0);
    expect(PM.Tables[P].points).toBe(20);
  });

  test('playing a card does not mutate the shared config card', () => {
    scriptRounds([10]);
    beginMatch(K1Config, [PazaakCards.PLUS_MINUS_2]);
    playCard(0, true);
    expect(PM.Tables[P].points).toBe(8);
    expect(K1Config.data.sideDeckCards[PazaakCards.PLUS_MINUS_2]).not.toHaveProperty('flipped');
  });

  test('AI rescues its own bust with a minus card', () => {
    // P10 O6 P2 O9(15) P2 O8(23) -> AI plays -4 -> 19 and stands
    scriptRounds([10, 6, 2, 9, 2, 8]);
    beginMatch(K1Config, [], [PazaakCards.MINUS_4]);
    endTurn();
    endTurn();
    endTurn();
    expect(PM.Tables[O].points).toBe(19);
    expect(PM.Tables[O].stand).toBe(true);
    expect(PM.Tables[O].handCards.get(0)).toBe(PazaakCards.INVALID);
    expect(PM.Tables[P].winCount + PM.Tables[O].winCount).toBe(0);
  });
});

describe('PazaakManager match + payout', () => {
  // player stands on 19; AI (no hand) keeps drawing behind and busts
  const playerWinsRound = [10, 10, 9, 5, 10];
  // player busts with no hand cards
  const playerLosesRound = [10, 2, 5, 2, 9];

  test('first to three round wins ends the match and pays +wager', () => {
    scriptRounds(playerWinsRound, playerWinsRound, playerWinsRound);
    beginMatch(K1Config);
    for(let round = 0; round < 3; round++){
      endTurn();
      stand();
      if(round < 2) expect(PM.Tables[P].winCount).toBe(round + 1);
    }
    expect(PM.Tables[P].winCount).toBe(3);
    expect(PM.Won).toBe(true);
    expect(addGold).toHaveBeenCalledTimes(1);
    expect(addGold).toHaveBeenCalledWith(100);
    expect(state.MenuManager.MenuPazaakGame.close).toHaveBeenCalled();
  });

  test('losing the match costs exactly the wager', () => {
    scriptRounds(playerLosesRound, playerLosesRound, playerLosesRound);
    beginMatch(K1Config);
    for(let round = 0; round < 3; round++){
      endTurn();
      endTurn();
    }
    expect(PM.Tables[O].winCount).toBe(3);
    expect(PM.Won).toBe(false);
    expect(addGold).toHaveBeenCalledWith(-100);
  });

  test('two round wins is not a match', () => {
    scriptRounds(playerWinsRound, playerWinsRound, [1]);
    beginMatch(K1Config);
    for(let round = 0; round < 2; round++){
      endTurn();
      stand();
    }
    expect(PM.Tables[P].winCount).toBe(2);
    expect(addGold).not.toHaveBeenCalled();
  });
});

describe('PazaakManager side deck', () => {
  test('hand is dealt from distinct side deck slots', () => {
    PM.Config = K1Config as any;
    for(let i = 0; i < 10; i++){
      PM.PlayerSideDeck.set(i, i < 4 ? [PazaakCards.PLUS_1, PazaakCards.MINUS_2, PazaakCards.PLUS_MINUS_3, PazaakCards.MINUS_6][i] : PazaakCards.INVALID);
      PM.OpponentSideDeck.set(i, PazaakCards.PLUS_1);
    }
    PM.BeginGame();
    const hand = [0, 1, 2, 3].map((i) => PM.Tables[P].handCards.get(i)).sort((a, b) => a - b);
    expect(hand).toEqual([PazaakCards.PLUS_1, PazaakCards.MINUS_2, PazaakCards.MINUS_6, PazaakCards.PLUS_MINUS_3].sort((a, b) => a - b));
    // a deck of ten +1s legitimately deals four +1s
    expect([0, 1, 2, 3].map((i) => PM.Tables[O].handCards.get(i))).toEqual(Array(4).fill(PazaakCards.PLUS_1));
  });

  test('TSL special cards can be added to the collection in TSL only', () => {
    state.GameKey = 'TSL';
    const before = PM.Cards.get(PazaakCards.TSL_DOUBLE).count;
    expect(PM.AddCard(PazaakCards.TSL_DOUBLE, 1)).toBe(true);
    expect(PM.Cards.get(PazaakCards.TSL_DOUBLE).count).toBe(before + 1);
    state.GameKey = 'KOTOR';
    expect(PM.AddCard(PazaakCards.TSL_DOUBLE, 1)).toBe(false);
  });
});
