import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/loaders', () => ({ ResourceLoader: {} }));
jest.mock('@/three/odyssey', () => ({ OdysseyModel3D: class {} }));
jest.mock('@/engine/CurrentGame', () => ({ CurrentGame: {} }));
jest.mock('@/utility/GameFileSystem', () => ({ GameFileSystem: {} }));
jest.mock('@/managers/TLKManager', () => ({ TLKManager: { GetStringById: (): undefined => undefined } }));
jest.mock('@/module/ModuleCreature', () => ({ ModuleCreature: class {} }));
jest.mock('@/module/ModulePlayer', () => ({ ModulePlayer: class {} }));

import { GameState } from '@/GameState';
import { PartyManager } from '@/managers/PartyManager';
import { InventoryManager } from '@/managers/InventoryManager';
import { PazaakManager } from '@/managers/PazaakManager';
import { PazaakCards } from '@/enums/minigames/PazaakCards';
import { BaseItemType } from '@/enums/combat/BaseItemType';
import { GFFObject } from '@/resource/GFFObject';
import { GFFStruct } from '@/resource/GFFStruct';
import { GFFField } from '@/resource/GFFField';
import { GFFDataType } from '@/enums/resource/GFFDataType';

const state = GameState as any;
const PM = PazaakManager;

function roundTrip(write: (root: GFFStruct) => void): GFFStruct {
  const file = new GFFObject();
  file.FileType = 'PT  ';
  write(file.RootNode);
  const decoded = new GFFObject();
  decoded.parse(file.getExportBuffer());
  return decoded.RootNode;
}

function resetCollection(){
  for(let i = 0; i < PazaakCards.TSL_MAX_CARDS; i++) PM.Cards.set(i, { card: i, count: 0 });
  for(let i = 0; i < 10; i++) PM.PlayerSideDeck.set(i, PazaakCards.INVALID);
}

beforeEach(() => {
  state.PazaakManager = PazaakManager;
  state.PartyManager = PartyManager;
  state.GameKey = 'KOTOR';
  resetCollection();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('PARTYTABLE pazaak collection', () => {
  test('K1 round trip keeps the 19-entry layout (unused 19th is a BYTE 0)', () => {
    PM.Cards.get(PazaakCards.PLUS_1).count = 3;
    PM.Cards.get(PazaakCards.PLUS_MINUS_6).count = 1;
    PM.PlayerSideDeck.set(0, PazaakCards.PLUS_1);
    PM.PlayerSideDeck.set(9, PazaakCards.PLUS_MINUS_6);
    const root = roundTrip((r) => PartyManager.WritePazaakCollection(r));

    const cards = root.getFieldByLabel('PT_PAZAAKCARDS').getChildStructs();
    expect(cards).toHaveLength(PazaakCards.MAX_CARDS + 1);
    expect(cards[PazaakCards.UNUSED_CARD].getFieldByLabel('PT_PAZAAKCOUNT').getType()).toBe(GFFDataType.BYTE);
    expect(cards[0].getFieldByLabel('PT_PAZAAKCOUNT').getType()).toBe(GFFDataType.INT);

    resetCollection();
    PartyManager.ReadPazaakCollection(root);
    expect(PM.Cards.get(PazaakCards.PLUS_1).count).toBe(3);
    expect(PM.Cards.get(PazaakCards.PLUS_MINUS_6).count).toBe(1);
    expect(PM.PlayerSideDeck.get(0)).toBe(PazaakCards.PLUS_1);
    expect(PM.PlayerSideDeck.get(9)).toBe(PazaakCards.PLUS_MINUS_6);
  });

  test('TSL round trip writes 23 INT entries and keeps the special cards', () => {
    state.GameKey = 'TSL';
    PM.Cards.get(PazaakCards.TSL_PLUS_MINUS_1_OR_2).count = 2;
    PM.Cards.get(PazaakCards.TSL_FLIP_3_6).count = 1;
    PM.PlayerSideDeck.set(3, PazaakCards.TSL_TIEBREAKER);
    const root = roundTrip((r) => PartyManager.WritePazaakCollection(r));

    const cards = root.getFieldByLabel('PT_PAZAAKCARDS').getChildStructs();
    expect(cards).toHaveLength(PazaakCards.TSL_MAX_CARDS);
    cards.forEach((c) => expect(c.getFieldByLabel('PT_PAZAAKCOUNT').getType()).toBe(GFFDataType.INT));

    resetCollection();
    PartyManager.ReadPazaakCollection(root);
    expect(PM.Cards.get(PazaakCards.TSL_PLUS_MINUS_1_OR_2).count).toBe(2);
    expect(PM.Cards.get(PazaakCards.TSL_FLIP_3_6).count).toBe(1);
    expect(PM.PlayerSideDeck.get(3)).toBe(PazaakCards.TSL_TIEBREAKER);
  });

  test('a short/older save loads without throwing and zeroes the missing entries', () => {
    state.GameKey = 'TSL';
    // stale state from a previous session
    for(let i = 0; i < PazaakCards.TSL_MAX_CARDS; i++) PM.Cards.get(i).count = 7;
    for(let i = 0; i < 10; i++) PM.PlayerSideDeck.set(i, PazaakCards.PLUS_2);

    const root = roundTrip((r) => {
      const list = r.addField(new GFFField(GFFDataType.LIST, 'PT_PAZAAKCARDS'));
      for(let i = 0; i < 5; i++){
        const s = new GFFStruct(0);
        s.addField(new GFFField(GFFDataType.INT, 'PT_PAZAAKCOUNT')).setValue(1);
        list.addChildStruct(s);
      }
      list.addChildStruct(new GFFStruct(0)); // struct missing PT_PAZAAKCOUNT
      const side = r.addField(new GFFField(GFFDataType.LIST, 'PT_PAZSIDELIST'));
      const s = new GFFStruct(0);
      s.addField(new GFFField(GFFDataType.INT, 'PT_PAZSIDECARD')).setValue(PazaakCards.MINUS_3);
      side.addChildStruct(s);
    });

    expect(() => PartyManager.ReadPazaakCollection(root)).not.toThrow();
    for(let i = 0; i < 5; i++) expect(PM.Cards.get(i).count).toBe(1);
    for(let i = 5; i < PazaakCards.TSL_MAX_CARDS; i++) expect(PM.Cards.get(i).count).toBe(0);
    expect(PM.PlayerSideDeck.get(0)).toBe(PazaakCards.MINUS_3);
    for(let i = 1; i < 10; i++) expect(PM.PlayerSideDeck.get(i)).toBe(PazaakCards.INVALID);
  });
});

describe('pazaak card items', () => {
  class CardItem {
    constructor(public variation: number, public count = 1) {}
    initProperties() {}
    getStackSize() { return this.count; }
    setStackSize(n: number) { this.count = n; }
    getBaseItemId() { return BaseItemType.PAZAAK_CARD; }
    getModelVariation() { return this.variation; }
  }

  beforeEach(() => {
    state.Module = { ModuleArea: { ModuleItem: CardItem } };
    state.UINotificationManager = { EnableUINotificationIconType: jest.fn() };
  });

  test('ModelVariation 1 is the +1 card and 18 is ±6 (variation is 1-based)', () => {
    InventoryManager.addItem(new CardItem(1, 2) as any);
    InventoryManager.addItem(new CardItem(18) as any);
    expect(PM.Cards.get(PazaakCards.PLUS_1).count).toBe(2);
    expect(PM.Cards.get(PazaakCards.PLUS_2).count).toBe(0);
    expect(PM.Cards.get(PazaakCards.PLUS_MINUS_6).count).toBe(1);
  });
});
