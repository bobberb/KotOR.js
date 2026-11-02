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
  };
}

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

  test('TSL setup wires a TSL special card button to the side deck (BTN_AVAIL34 = card 22)', async () => {
    state.GameKey = 'TSL';
    PM.Config = TSLConfig as any;
    for(let i = 0; i < 10; i++) PM.PlayerSideDeck.set(i, PazaakCards.INVALID);
    PM.Cards.get(PazaakCards.TSL_FLIP_3_6).count = 1;
    const menu = withControls(new TSLSetup());
    await menu.menuControlInitializer();
    (menu as any).BTN_AVAIL34.click();
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
