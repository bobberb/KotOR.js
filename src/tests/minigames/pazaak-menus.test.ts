import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/module/ModuleCreature', () => ({ ModuleCreature: class {} }));
jest.mock('@/gui', () => ({
  GameMenu: class {
    async menuControlInitializer(_skip?: boolean) {}
    open() {}
    close() {}
    show() {}
    hide() {}
    update(_d?: number) {}
    rebuild() {}
    getControlByName(name: string) { return (this as any)[name]; }
  },
}));
// The game index pulls in the whole engine; the TSL menus only need their K1 bases.
jest.mock('@/game/kotor/KOTOR', () => ({
  MenuPazaakGame: jest.requireActual<any>('@/game/kotor/menu/MenuPazaakGame').MenuPazaakGame,
  MenuPazaakSetup: jest.requireActual<any>('@/game/kotor/menu/MenuPazaakSetup').MenuPazaakSetup,
}));

import { GameState } from '@/GameState';
import { PazaakManager } from '@/managers/PazaakManager';
import { PazaakCards } from '@/enums/minigames/PazaakCards';
import { MenuPazaakSetup as K1Setup } from '@/game/kotor/menu/MenuPazaakSetup';
import { MenuPazaakSetup as TSLSetup } from '@/game/tsl/menu/MenuPazaakSetup';
import { MenuPazaakGame as TSLGame } from '@/game/tsl/menu/MenuPazaakGame';
import { PazaakConfig as TSLConfig } from '@/game/tsl/minigames/mg-pazaak-config';
import { PazaakConfig as K1Config } from '@/game/kotor/minigames/mg-pazaak-config';
import { MenuPazaakGame as K1Game } from '@/game/kotor/menu/MenuPazaakGame';
import { MenuPazaakWager as K1Wager } from '@/game/kotor/menu/MenuPazaakWager';

const state = GameState as any;
const PM = PazaakManager;

/** A control stub that records listeners so tests can click it. */
function control(){
  const listeners: Record<string, Function[]> = {};
  return {
    listeners,
    hidden: false,
    disableSelection: false,
    addEventListener(type: string, cb: Function){ (listeners[type] ||= []).push(cb); },
    click(){ (listeners.click || []).forEach((cb) => cb()); },
    show(){ this.hidden = false; },
    hide(){ this.hidden = true; },
    setText: jest.fn(),
    setFillTextureName: jest.fn(),
    defaultColor: { setRGB(){} },
    defaultHighlightColor: { setRGB(){} },
  };
}

const lastArg = (fn: any) => fn.mock.calls[fn.mock.calls.length - 1]?.[0];

/** Fill every BTN_/LBL_ control name the menu asks for with a stub. */
function withControls<T extends object>(menu: T): T {
  return new Proxy(menu, {
    get(target: any, key, receiver){
      if(typeof key === 'string' && /^(BTN|LBL)_/.test(key) && target[key] === undefined){
        target[key] = control();
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

beforeEach(() => {
  state.PazaakManager = PazaakManager;
  state.MenuManager = { MenuPazaakGame: { open: jest.fn() }, MenuPazaakWager: { open: jest.fn() } };
  state.PartyManager = {};
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('MenuPazaakSetup card list', () => {
  test('K1 lists cards 0-17', () => {
    state.GameKey = 'KOTOR';
    const list = new K1Setup().getAvailableCardIndices();
    expect(list).toEqual(Array.from({ length: 18 }, (_, i) => i));
  });

  test('TSL lists cards 0-22, including the special cards', () => {
    state.GameKey = 'TSL';
    const list = new TSLSetup().getAvailableCardIndices();
    expect(list).toEqual(Array.from({ length: 23 }, (_, i) => i));
    expect(list).toContain(PazaakCards.TSL_FLIP_3_6);
  });

  test('TSL setup wires a TSL special card button to the side deck (BTN_AVAIL32 = card 20, flip 3&6)', async () => {
    state.GameKey = 'TSL';
    PM.Config = TSLConfig as any;
    for(let i = 0; i < 10; i++) PM.PlayerSideDeck.set(i, PazaakCards.INVALID);
    PM.Cards.get(PazaakCards.TSL_FLIP_3_6).count = 1;
    const menu = withControls(new TSLSetup());
    await menu.menuControlInitializer();
    (menu as any).BTN_AVAIL32.click();
    expect(PM.PlayerSideDeck.get(0)).toBe(PazaakCards.TSL_FLIP_3_6);
    expect(PM.Cards.get(PazaakCards.TSL_FLIP_3_6).count).toBe(0);
  });
});

describe('TSL MenuPazaakGame 1±2 value choice', () => {
  beforeEach(() => {
    state.GameKey = 'TSL';
    PM.Config = TSLConfig as any;
    PM.ClearActions();
    const table = PM.Tables[0];
    table.handCardPlayed = false;
    table.handCards.set(0, PazaakCards.TSL_PLUS_MINUS_1_OR_2);
    table.handCards.set(1, PazaakCards.PLUS_3);
    table.flipCards.set(0, false);
    table.swapValueCards.set(0, false);
    table.swapValueCards.set(1, false);
    PM.TurnMode = 0;
  });

  test('BTN_CHANGE0 selects the 2 value and the play action carries it', async () => {
    const menu = withControls(new TSLGame());
    await menu.menuControlInitializer();
    const spy = jest.spyOn(PM, 'AddPlayHandCardAction');

    (menu as any).BTN_CHANGE0.click();
    expect(PM.Tables[0].swapValueCards.get(0)).toBe(true);
    (menu as any).BTN_FLIP0.click();
    (menu as any).BTN_PLRSIDE0.click();

    expect(spy).toHaveBeenCalledWith(0, 0, true);
    const action = PM.Actions[0];
    expect(action.properties.map((p) => p.value)).toEqual([0, 0, 1, 1]); // table, hand, flipped, swapped
  });

  test('BTN_CHANGE toggles back and ignores cards without an alternate value', async () => {
    const menu = withControls(new TSLGame());
    await menu.menuControlInitializer();
    (menu as any).BTN_CHANGE0.click();
    (menu as any).BTN_CHANGE0.click();
    expect(PM.Tables[0].swapValueCards.get(0)).toBe(false);
    (menu as any).BTN_CHANGE1.click();
    expect(PM.Tables[0].swapValueCards.get(1)).toBe(false);
  });
});

describe('table card labels show resolved values', () => {
  /** Put main deck cards on the player's table, then play hand card 0 through the queue. */
  function playOnto(config: any, mainValues: number[], handCard: PazaakCards, flipped = false){
    PM.Config = config;
    PM.ClearActions();
    PM.TurnMode = 0;
    const table = PM.Tables[0];
    table.handCardPlayed = false;
    for(let i = 0; i < 9; i++) table.cardArea.set(i, undefined);
    mainValues.forEach((v, i) => table.cardArea.set(i, { ...config.data.mainDeckCards[v - 1], value: v }));
    for(let i = 0; i < 4; i++) table.handCards.set(i, i == 0 ? handCard : PazaakCards.INVALID);
    for(let i = 0; i < 9; i++) PM.Tables[1].cardArea.set(i, undefined);
    for(let i = 0; i < 4; i++) PM.Tables[1].handCards.set(i, PazaakCards.INVALID);
    PM.AddPlayHandCardAction(0, 0, flipped);
    let n = 0;
    while(PM.Actions.length && n++ < 50) PM.ProcessActionQueue(10);
  }

  beforeEach(() => {
    state.guiAudioEmitter = { playSoundFireAndForget: jest.fn() };
    state.PartyManager = {};
  });

  test('TSL: after Flip 2&4 the table reads -2, -4, 10, 2&4 with negative textures', async () => {
    state.GameKey = 'TSL';
    playOnto(TSLConfig, [2, 4, 10], PazaakCards.TSL_FLIP_2_4);
    const menu = withControls(new TSLGame()) as any;
    menu.rebuild();
    expect([0, 1, 2, 3].map((i) => lastArg(menu[`LBL_PLR${i}`].setText))).toEqual(['-2', '-4', '10', '2&4']);
    expect(lastArg(menu.BTN_PLR0.setFillTextureName)).toBe('pcards_neg_p');
    expect(lastArg(menu.BTN_PLR1.setFillTextureName)).toBe('pcards_neg_p');
    expect(lastArg(menu.BTN_PLR2.setFillTextureName)).toBe('pcards_generic_p');
  });

  test('TSL: the Double card shows the value it copied', async () => {
    state.GameKey = 'TSL';
    playOnto(TSLConfig, [10, 5], PazaakCards.TSL_DOUBLE);
    const menu = withControls(new TSLGame()) as any;
    menu.rebuild();
    expect(lastArg(menu.LBL_PLR2.setText)).toBe('+5');
    expect(PM.Tables[0].points).toBe(20);
  });

  test('K1: a flipped ±3 reads -3 on the reversible-negative texture', async () => {
    state.GameKey = 'KOTOR';
    playOnto(K1Config, [10, 8], PazaakCards.PLUS_MINUS_3, true);
    const menu = withControls(new K1Game()) as any;
    menu.rebuild();
    expect(lastArg(menu.LBL_PLR2.setText)).toBe('-3');
    expect(lastArg(menu.BTN_PLR2.setFillTextureName)).toBe('lbl_cardraref');
    expect(lastArg(menu.LBL_PLR0.setText)).toBe('10');
  });
});

describe('opponent hand card backs', () => {
  function rebuildWithOpponentCard(Menu: any, config: any){
    PM.Config = config;
    PM.ClearActions();
    PM.TurnMode = 0;
    for(let t = 0; t < 2; t++){
      for(let i = 0; i < 9; i++) PM.Tables[t].cardArea.set(i, undefined);
      for(let i = 0; i < 4; i++) PM.Tables[t].handCards.set(i, PazaakCards.INVALID);
    }
    PM.Tables[1].handCards.set(0, PazaakCards.PLUS_1);
    state.PartyManager = {};
    const menu = withControls(new Menu()) as any;
    menu.rebuild();
    return lastArg(menu.BTN_NPCSIDE0.setFillTextureName);
  }

  test('K1 uses lbl_cardback', () => {
    state.GameKey = 'KOTOR';
    expect(rebuildWithOpponentCard(K1Game, K1Config)).toBe('lbl_cardback');
  });

  test('TSL uses its own pcards_back_p', () => {
    state.GameKey = 'TSL';
    expect(rebuildWithOpponentCard(TSLGame, TSLConfig)).toBe('pcards_back_p');
  });
});

describe('MenuPazaakWager', () => {
  test('a player with 0 credits cannot bet: wager is 0', () => {
    PM.MinWager = 1;
    PM.MaxWager = 100;
    PM.Wager = 100;
    state.PartyManager = { Gold: 0 };
    const menu = withControls(new K1Wager()) as any;
    menu.rebuild();
    expect(PM.Wager).toBe(0);
    expect(lastArg(menu.LBL_WAGERVAL.setText)).toBe('0');
  });

  test('wager is capped at the player credits', () => {
    PM.MinWager = 1;
    PM.MaxWager = 100;
    PM.Wager = 100;
    state.PartyManager = { Gold: 30 };
    withControls(new K1Wager()).rebuild();
    expect(PM.Wager).toBe(30);
  });
});
