import { beforeEach, describe, expect, jest, test } from '@jest/globals';

/**
 * Starting a new game must not inherit anything a save loaded earlier in the session put in
 * PARTYTABLE or INVENTORY.res.
 *
 * Drives the real CharGenManager.startNewGame (the single path every K1/TSL Quick/Custom new
 * game takes) against the real PartyManager, JournalManager, DialogMessageManager,
 * FeedbackMessageManager, PazaakManager, Planetary and InventoryManager: load a mid-game
 * PARTYTABLE and inventory, start a new game, check every piece is fresh, then check the next
 * PARTYTABLE export writes fresh values too.
 */

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/gui', () => ({ GameMenu: class {}, LBL_3DView: class {} }));
jest.mock('@/audio/AudioLoader', () => ({ AudioLoader: class {} }));
jest.mock('@/engine/CurrentGame', () => ({ CurrentGame: { InitGameInProgressFolder: jest.fn(async () => undefined), gameinprogress_dir: 'gip', WriteFile: jest.fn() } }));
jest.mock('@/utility/GameFileSystem', () => ({ GameFileSystem: { readFile: async () => new Uint8Array() } }));
jest.mock('@/loaders/ResourceLoader', () => ({ ResourceLoader: {} }));
jest.mock('@/loaders', () => ({ MDLLoader: {}, ResourceLoader: {} }));
jest.mock('@/loaders/MDLLoader', () => ({ MDLLoader: { loader: { load: async (): Promise<undefined> => undefined } } }));
jest.mock('@/odyssey', () => ({
  OdysseyModel: class {}, OdysseyModelAnimation: class {}, OdysseyWalkMesh: class {},
}));
jest.mock('@/three/odyssey', () => {
  const THREE = jest.requireActual('three') as typeof import('three');
  return {
    OdysseyModel3D: class {}, OdysseyObject3D: class extends THREE.Object3D {}, OdysseyLightsaberEffect: class {},
  };
});
jest.mock('@/nwscript/NWScript', () => ({ NWScript: class {} }));
jest.mock('@/nwscript/NWScriptInstance', () => ({ NWScriptInstance: class {} }));
jest.mock('@/nwscript/events', () => ({ NWScriptEvent: class {} }));
jest.mock('@/engine/CollisionManager', () => ({ CollisionManager: class {} }));
jest.mock('@/combat', () => ({ CombatRound: class {}, CombatRoundAction: class {} }));

import { GameState } from '@/GameState';
import { CharGenManager } from '@/managers/CharGenManager';
import { PartyManager } from '@/managers/PartyManager';
import { JournalManager } from '@/managers/JournalManager';
import { DialogMessageManager } from '@/managers/DialogMessageManager';
import { FeedbackMessageManager } from '@/managers/FeedbackMessageManager';
import { PazaakManager } from '@/managers/PazaakManager';
import { InventoryManager } from '@/managers/InventoryManager';
import { Planetary } from '@/engine/Planetary';
import { ModulePlayer } from '@/module/ModulePlayer';
import { GFFObject } from '@/resource/GFFObject';
import { GFFField } from '@/resource/GFFField';
import { GFFStruct } from '@/resource/GFFStruct';
import { GFFDataType } from '@/enums/resource/GFFDataType';
import { GameEngineType } from '@/enums/engine/GameEngineType';
import { PazaakCards } from '@/enums/minigames/PazaakCards';
import * as GFFObjectModule from '@/resource/GFFObject';
import * as CurrentGameModule from '@/engine/CurrentGame';
import { loadSourceWithStubs } from './support/loadSourceWithStubs';

const state = GameState as any;
const PLANETS = ['EndarSpire', 'Taris', 'Dantooine', 'Tatooine'];

function soldierClass(): any {
  return {
    id: 0, level: 1, hitdie: 10, forcedie: 0,
    savingThrows: [{ level: 1, fortsave: 2, refsave: 1, willsave: 3 }],
    isFeatGrantedAtLevel: () => false,
    getACBonus: () => 0,
    save: () => new GFFStruct(),
  };
}

/** Stands in for ModuleItem: InventoryManager.addItem only needs these methods. */
class FakeItem {
  constructor(public template: GFFObject){}
  initProperties(){}
  load(){}
  getStackSize(){ return 1; }
  setStackSize(){}
  getBaseItemId(){ return 1; }
  canStackWith(){ return false; }
}

function list(root: GFFStruct, label: string, rows: Array<Record<string, [GFFDataType, any]>>){
  const field = root.addField(new GFFField(GFFDataType.LIST, label));
  for(const row of rows){
    const s = new GFFStruct();
    for(const [k, [type, value]] of Object.entries(row)){ s.addField(new GFFField(type, k)).setValue(value); }
    field.addChildStruct(s);
  }
}

/** A TSL PARTYTABLE as a mid-game save writes it, every section populated. */
function midGamePartyTable(): GFFObject {
  Planetary.SetPlanetAvailable(2, true);
  Planetary.SetPlanetSelectable(2, true);
  Planetary.SetSelectedPlanet(2);
  const gff = new GFFObject();
  const root = gff.RootNode;
  root.addField(new GFFField(GFFDataType.STRUCT, 'GlxyMap')).addChildStruct(Planetary.SaveStruct());
  root.addField(new GFFField(GFFDataType.DWORD, 'PT_GOLD')).setValue(4000);
  root.addField(new GFFField(GFFDataType.INT, 'PT_XP_POOL')).setValue(900);
  root.addField(new GFFField(GFFDataType.BYTE, 'PT_SOLOMODE')).setValue(1);
  root.addField(new GFFField(GFFDataType.BYTE, 'PT_DISABLEREGEN')).setValue(1);
  root.addField(new GFFField(GFFDataType.INT, 'PT_SWOOP1')).setValue(2);
  root.addField(new GFFField(GFFDataType.VOID, 'PT_TUT_WND_SHOWN')).setData(new Uint8Array([0xff, 0xff]));
  root.addField(new GFFField(GFFDataType.INT, 'JNL_SortOrder')).setValue(3);
  list(root, 'JNL_Entries', [{ JNL_PlotID: [GFFDataType.CEXOSTRING, 'tar_bastila'], JNL_State: [GFFDataType.INT, 10], JNL_Date: [GFFDataType.DWORD, 1], JNL_Time: [GFFDataType.DWORD, 1] }]);
  list(root, 'PT_DLG_MSG_LIST', [{ PT_DLG_MSG_SPKR: [GFFDataType.CEXOSTRING, 'Carth'], PT_DLG_MSG_MSG: [GFFDataType.CEXOSTRING, 'old line'] }]);
  list(root, 'PT_FB_MSG_LIST', [{ PT_FB_MSG_MSG: [GFFDataType.CEXOSTRING, 'old feedback'], PT_FB_MSG_TYPE: [GFFDataType.DWORD, 0], PT_FB_MSG_COLOR: [GFFDataType.BYTE, 0] }]);
  list(root, 'PT_PAZAAKCARDS', Array.from({ length: 19 }, (_, i) => ({ PT_PAZAAKCOUNT: [GFFDataType.INT, i == 18 ? 0 : 4] })));
  list(root, 'PT_PAZSIDELIST', Array.from({ length: 10 }, () => ({ PT_PAZSIDECARD: [GFFDataType.INT, 3] })));
  list(root, 'PT_INFLUENCE', Array.from({ length: 12 }, () => ({ PT_NPC_INFLUENCE: [GFFDataType.INT, 90] })));
  list(root, 'PT_AVAIL_NPCS', Array.from({ length: 12 }, () => ({ PT_NPC_AVAIL: [GFFDataType.BYTE, 1], PT_NPC_SELECT: [GFFDataType.BYTE, 1] })));
  list(root, 'PT_PUPPETS', [{ PT_PUPPET_ID: [GFFDataType.DWORD, 0] }]);
  list(root, 'PT_MEMBERS', [{ PT_IS_LEADER: [GFFDataType.BYTE, 0], PT_MEMBER_ID: [GFFDataType.INT, 0] }]);
  return new GFFObject(gff.getExportBuffer());
}

beforeEach(async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  state.CharGenManager = CharGenManager;
  state.PartyManager = PartyManager;
  state.JournalManager = JournalManager;
  state.DialogMessageManager = DialogMessageManager;
  state.FeedbackMessageManager = FeedbackMessageManager;
  state.PazaakManager = PazaakManager;
  state.InventoryManager = InventoryManager;
  state.Planetary = Planetary;
  state.Module = { ModuleArea: { ModuleItem: FakeItem } };
  state.UINotificationManager = { EnableUINotificationIconType: jest.fn() };
  state.SWRuleSet = { skills: [], ranges: [], portraits: [], feats: [], classes: [] };
  state.ModuleObjectManager = { AddObjectById: jest.fn(), GetNextPlayerId: jest.fn(() => 1) };
  state.FactionManager = { factions: new Map(), AddCreatureToFaction: jest.fn() };
  state.AppearanceManager = { GetCreatureAppearanceById: (): undefined => undefined };
  state.ActionFactory = { FromStruct: jest.fn(() => undefined) };
  const rows: Record<number, any> = {};
  PLANETS.forEach((label, i) => rows[i] = { __rowlabel: String(i), label, name: '0', description: '0', icon: '****', model: '****', guitag: `LBL_Planet_${label}`, lockedoutreason: '****' });
  state.TwoDAManager = { datatables: new Map<string, any>([['planetary', { rows, RowCount: PLANETS.length }], ['tutorial', { rows: {}, RowCount: 16 }]]) };
  state.TutorialWindowTracker = [];
  state.GlobalVariableManager = { Init: jest.fn() };
  state.LoadModule = jest.fn();
  state.time = 0;
  await Planetary.Init();
  PazaakManager.Initialize();
  freshCardCounts = [...PazaakManager.Cards.values()].map((c) => c.count);
  InventoryManager.ClearInventory();
  JournalManager.ClearEntries();
  DialogMessageManager.ClearEntries();
  FeedbackMessageManager.ClearEntries();
});

function protagonist(){
  const player = new ModulePlayer(new GFFObject());
  player.classes = [soldierClass()];
  player.firstName = 'Exile';
  (player as any).portrait = { getPortraitGoodEvil: () => 'po_pexile' };
  return player;
}

async function exportPartyTable(): Promise<GFFObject> {
  let bytes: Uint8Array | undefined;
  jest.spyOn(GFFObject.prototype, 'export').mockImplementation(function(this: GFFObject, _f: string, onExport?: Function){
    bytes = this.getExportBuffer();
    onExport?.();
    return Promise.resolve(this);
  });
  await PartyManager.Export('save');
  return new GFFObject(bytes!);
}

// What a fresh PazaakManager holds (2 each of the first five cards, none of the rest), read off a fresh Initialize()
// so the test does not hard-code how many card kinds each game has.
let freshCardCounts: number[] = [];
const freshCards = () => freshCardCounts;

describe.each([GameEngineType.TSL, GameEngineType.KOTOR])('new game after loading a save (%s)', (game) => {
  test('every PARTYTABLE section and the inventory start fresh; the protagonist and portrait survive', async () => {
    state.GameKey = GameEngineType.TSL;
    PartyManager.Initialize();
    await PartyManager.Load(midGamePartyTable());
    InventoryManager.addItem(new GFFObject());

    // The save really did populate every manager.
    expect({
      gold: PartyManager.Gold, solo: state.SOLOMODE, members: PartyManager.CurrentMembers.length,
      journal: JournalManager.Entries.length, sort: JournalManager.SortOrder,
      dlg: DialogMessageManager.Entries.length, fb: FeedbackMessageManager.Entries.length,
      card0: PazaakManager.Cards.get(0)!.count, side0: PazaakManager.PlayerSideDeck.get(0),
      tutorial0: state.TutorialWindowTracker[0], planet2: Planetary.planets[2].enabled, selected: Planetary.selectedIndex,
      inventory: InventoryManager.inventory.length,
    }).toEqual({
      gold: 4000, solo: true, members: 1, journal: 1, sort: 3, dlg: 1, fb: 1, card0: 4, side0: 3,
      tutorial0: 1, planet2: true, selected: 2, inventory: 1,
    });

    state.GameKey = game;
    CharGenManager.selectedCreature = protagonist();
    await CharGenManager.startNewGame();

    expect(state.LoadModule).toHaveBeenCalledWith(CharGenManager.getStartModule());
    expect(PartyManager.ActualPlayerTemplate).toBe(PartyManager.PlayerTemplate);
    expect(PartyManager.PlayerTemplate.RootNode.getFieldByLabel('IsPC').getValue()).toBe(1);
    // Chargen registers the portrait after the reset; a reset moved after it would wipe it.
    expect(PartyManager.PortraitOrder).toEqual(['po_pexile']);

    expect({
      gold: PartyManager.Gold, xp: PartyManager.XPPool, solo: state.SOLOMODE, noRegen: state.disableHealthRegen,
      swoop: PartyManager.SwoopUpgrade1, influence: PartyManager.InfluenceMap.get(0), npc0: PartyManager.NPCS[0].available,
      members: PartyManager.CurrentMembers, puppets: PartyManager.PuppetMembers,
      maxParty: PartyManager.MaxPartyCount,
      journal: JournalManager.Entries, sort: JournalManager.SortOrder,
      dlg: DialogMessageManager.Entries, fb: FeedbackMessageManager.Entries,
      cards: [...PazaakManager.Cards.values()].map(c => c.count),
      side: [...PazaakManager.PlayerSideDeck.values()],
      tutorial: state.TutorialWindowTracker.filter(Boolean),
      planets: Planetary.planets.map(p => [p.enabled, p.selectable]), selected: Planetary.selectedIndex,
      inventory: InventoryManager.inventory,
    }).toEqual({
      gold: 0, xp: 0, solo: false, noRegen: false, swoop: -1, influence: PartyManager.INFLUENCE_DEFAULT, npc0: false,
      members: [], puppets: [], maxParty: game == GameEngineType.TSL ? 12 : 9,
      journal: [], sort: 0, dlg: [], fb: [],
      cards: freshCards(), side: Array(10).fill(PazaakCards.INVALID),
      tutorial: [], planets: PLANETS.map(() => [false, false]), selected: -1,
      inventory: [],
    });

    // The new game's first save writes the fresh state, not the old playthrough's.
    const saved = await exportPartyTable();
    const root = saved.RootNode;
    const ints = (label: string, field: string) => root.getFieldByLabel(label).getChildStructs().map(s => s.getFieldByLabel(field).getValue());
    expect(root.getFieldByLabel('JNL_Entries').getChildStructs()).toEqual([]);
    expect(root.getFieldByLabel('JNL_SortOrder').getValue()).toBe(0);
    expect(root.getFieldByLabel('PT_DLG_MSG_LIST').getChildStructs()).toEqual([]);
    expect(root.getFieldByLabel('PT_FB_MSG_LIST').getChildStructs()).toEqual([]);
    const savedCounts = ints('PT_PAZAAKCARDS', 'PT_PAZAAKCOUNT');
    expect(savedCounts).toEqual(freshCards().slice(0, savedCounts.length));
    expect(savedCounts.slice(0, 5)).toEqual([2, 2, 2, 2, 2]);
    expect(ints('PT_PAZSIDELIST', 'PT_PAZSIDECARD')).toEqual(Array(10).fill(PazaakCards.INVALID));
    expect(Array.from(root.getFieldByLabel('PT_TUT_WND_SHOWN').getVoid())).toEqual([0, 0]);
    expect(root.getFieldByLabel('PT_GOLD').getValue()).toBe(0);
    expect(root.getFieldByLabel('PT_SOLOMODE').getValue()).toBe(0);
    expect(root.getFieldByLabel('PT_MEMBERS').getChildStructs()).toEqual([]);
    Planetary.SetSelectedPlanet(1);
    Planetary.LoadStruct(root.getFieldByLabel('GlxyMap').getChildStructs()[0]);
    expect(Planetary.planets.map(p => p.enabled)).toEqual(PLANETS.map(() => false));
    expect(Planetary.selectedIndex).toBe(-1);
  });
});

describe('InventoryManager.ClearInventory', () => {
  test('destroys the items it drops, so their object-id registrations do not leak', () => {
    const items = [new FakeItem(new GFFObject()), new FakeItem(new GFFObject())] as any[];
    for(const item of items){ item.destroy = jest.fn(); }
    items[0].destroy.mockImplementation(() => { throw new Error('renderer gone'); }); // one failing destroy must not stop the rest
    InventoryManager.inventory = items;
    InventoryManager.ClearInventory();
    expect(InventoryManager.inventory).toEqual([]);
    expect(items.map((i) => i.destroy.mock.calls.length)).toEqual([1, 1]);
  });
});

describe('SaveGame.loadInventory', () => {
  function inventoryRes(count: number){
    const gff = new GFFObject();
    const items = gff.RootNode.addField(new GFFField(GFFDataType.LIST, 'ItemList'));
    for(let i = 0; i < count; i++){
      const s = new GFFStruct();
      s.addField(new GFFField(GFFDataType.CEXOSTRING, 'Tag')).setValue(`item${i}`);
      items.addChildStruct(s);
    }
    return gff.getExportBuffer();
  }

  test('loading save B after save A replaces A\'s inventory instead of stacking on it', async () => {
    let file = inventoryRes(3);
    const { SaveGame } = loadSourceWithStubs('engine/SaveGame.ts', {
      '@/GameState': { GameState },
      '@/resource/GFFObject': GFFObjectModule,
      '@/engine/CurrentGame': CurrentGameModule,
      '@/utility/GameFileSystem': { GameFileSystem: { readFile: async () => file } },
    });
    const save = Object.create(SaveGame.prototype);
    await save.loadInventory();
    expect(InventoryManager.inventory.length).toBe(3);
    file = inventoryRes(2);
    await save.loadInventory();
    expect(InventoryManager.inventory.map((i: any) => i.template.RootNode.getFieldByLabel('Tag').getValue())).toEqual(['item0', 'item1']);
  });
});
