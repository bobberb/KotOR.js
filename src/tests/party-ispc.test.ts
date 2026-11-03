import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

/**
 * IsPC on a saved creature means "the real protagonist", and nothing else.
 *
 * Module.setFromIFO trusts a Mod_PlayerList entry with IsPC=1 as the
 * ActualPlayerTemplate and otherwise falls back to the save's pc.utc.
 * SwitchPlayerCharacter used to set isPC=1 on whoever took control, companions
 * included (TSL puppet segments), and save() writes isPC back out. A save made
 * while a companion was in control therefore reloaded with the companion as the
 * protagonist; switching back to -1 then rebuilt the "player" from the
 * companion's template.
 *
 * Drives the real PartyManager.SwitchPlayerCharacter, the real
 * ModuleCreature.save() and the real Module.setFromIFO.
 */

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/utility/GameFileSystem', () => ({ GameFileSystem: {} }));
jest.mock('@/engine/CurrentGame', () => ({ CurrentGame: { WriteFile: jest.fn() } }));
jest.mock('@/loaders/ResourceLoader', () => ({ ResourceLoader: {} }));
jest.mock('@/loaders', () => ({ MDLLoader: {}, ResourceLoader: {}, TextureLoader: {} }));
jest.mock('@/odyssey', () => ({
  OdysseyModel: class {}, OdysseyModelAnimation: class {}, OdysseyWalkMesh: class {},
}));
jest.mock('@/three/odyssey', () => {
  const THREE = jest.requireActual('three') as typeof import('three');
  return {
    OdysseyModel3D: class {}, OdysseyObject3D: class extends THREE.Object3D {}, OdysseyLightsaberEffect: class {},
  };
});
jest.mock('@/engine/TextSprite3D', () => {
  const THREE = jest.requireActual('three') as typeof import('three');
  return { TextSprite3D: class { container = new THREE.Object3D(); setColor() {} } };
});
jest.mock('@/module/ModuleArea', () => ({ ModuleArea: class {} }));
jest.mock('@/nwscript/NWScript', () => ({ NWScript: class {} }));
jest.mock('@/nwscript/NWScriptInstance', () => ({ NWScriptInstance: class {} }));
jest.mock('@/nwscript/events', () => ({ NWScriptEvent: class {} }));
jest.mock('@/engine/CollisionManager', () => ({ CollisionManager: class {} }));
jest.mock('@/combat', () => ({ CombatRound: class {}, CombatRoundAction: class {} }));

import { GameState } from '@/GameState';
import { PartyManager } from '@/managers/PartyManager';
import { ModuleCreature } from '@/module/ModuleCreature';
import { ModulePlayer } from '@/module/ModulePlayer';
import { Module } from '@/module/Module';
import { GFFObject } from '@/resource/GFFObject';
import { GFFField } from '@/resource/GFFField';
import { GFFStruct } from '@/resource/GFFStruct';
import { GFFDataType } from '@/enums/resource/GFFDataType';
import { CurrentGame } from '@/engine/CurrentGame';
import { loadSourceWithStubs } from './support/loadSourceWithStubs';
import { buildRuntimeAction, EngineVariant } from '@/nwscript/builtins/actionBuilder';
import * as partyRoutines from '@/nwscript/builtins/party';

function routine(def: any, engine: EngineVariant = 'tsl', caller?: any) {
  const built = buildRuntimeAction(def, engine)!;
  return (...args: any[]) => built.action!.call({ caller }, args);
}

const state = GameState as any;

function creatureTemplate(tag: string, isPC: number): GFFObject {
  const gff = new GFFObject();
  gff.RootNode.addField(new GFFField(GFFDataType.CEXOSTRING, 'Tag')).setValue(tag);
  gff.RootNode.addField(new GFFField(GFFDataType.BYTE, 'IsPC')).setValue(isPC);
  return gff;
}

const isPCOf = (gff: GFFObject) => gff.RootNode.getFieldByLabel('IsPC').getValue();

/** A savegame IFO: the minimum Module.setFromIFO reads, plus Mod_PlayerList. */
function savegameIFO(player: GFFObject): GFFObject {
  const ifo = new GFFObject();
  const root = ifo.RootNode;
  const area = new GFFStruct();
  area.addField(new GFFField(GFFDataType.RESREF, 'Area_Name')).setValue('001ebo');
  root.addField(new GFFField(GFFDataType.LIST, 'Mod_Area_list')).addChildStruct(area);
  for (const label of ['Mod_Creator_ID', 'Mod_Entry_Dir_X', 'Mod_Entry_Dir_Y', 'Mod_Entry_X', 'Mod_Entry_Y',
    'Mod_Entry_Z', 'Mod_Version', 'Mod_XPScale']) {
    root.addField(new GFFField(GFFDataType.INT, label)).setValue(0);
  }
  root.addField(new GFFField(GFFDataType.CEXOLOCSTRING, 'Mod_Description'));
  root.addField(new GFFField(GFFDataType.CEXOLOCSTRING, 'Mod_Name'));
  root.addField(new GFFField(GFFDataType.RESREF, 'Mod_Entry_Area')).setValue('001ebo');
  root.addField(new GFFField(GFFDataType.CEXOSTRING, 'Mod_Hak')).setValue('');
  root.addField(new GFFField(GFFDataType.VOID, 'Mod_ID')).setValue(new Uint8Array(16));
  root.addField(new GFFField(GFFDataType.CEXOSTRING, 'Mod_Tag')).setValue('001EBO');
  for (const label of ['Mod_OnAcquirItem', 'Mod_OnActvtItem', 'Mod_OnClientEntr', 'Mod_OnClientLeav',
    'Mod_OnHeartbeat', 'Mod_OnModLoad', 'Mod_OnModStart', 'Mod_OnPlrDeath', 'Mod_OnPlrDying',
    'Mod_OnPlrLvlUp', 'Mod_OnPlrRest', 'Mod_OnSpawnBtnDn', 'Mod_OnUnAqreItem', 'Mod_OnUsrDefined']) {
    root.addField(new GFFField(GFFDataType.RESREF, label)).setValue('');
  }
  root.addField(new GFFField(GFFDataType.LIST, 'Mod_PlayerList')).addChildStruct(player.RootNode);
  return ifo;
}

/** Module.setFromIFO on a bare Module; only its player-template branch is under test. */
function loadSavegameModule(ifo: GFFObject){
  const module = Object.create(Module.prototype) as Module;
  (module as any).timeManager = { setFromIFO: () => {} };
  (module as any).scriptResRefs = new Map();
  module.setFromIFO(ifo, true);
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  // The model load is the async browser half; the switch's state change is synchronous.
  jest.spyOn(ModuleCreature.prototype, 'loadModel').mockReturnValue(new Promise(() => {}));
  jest.spyOn(ModuleCreature.prototype, 'loadScripts').mockImplementation(() => {});
  // The combat round is mocked out; there is no queue to clear.
  jest.spyOn(ModuleCreature.prototype, 'clearAllActions').mockImplementation(() => {});
  PartyManager.PendingDestroy = [];
  // The real destroy tears down the renderer side; the state that matters here is the flag.
  // Tests about destroy timing restore the real one.
  jest.spyOn(ModuleCreature.prototype, 'destroy').mockImplementation(function(this: ModuleCreature){ this.destroyed = true; });
  state.PartyManager = PartyManager;
  state.SWRuleSet = { skills: [], ranges: [], portraits: [], feats: [], classes: [] };
  state.ModuleObjectManager = { AddObjectById: jest.fn(), GetNextPlayerId: jest.fn(() => 1) };
  state.FactionManager = { factions: new Map(), AddCreatureToFaction: jest.fn() };
  state.AppearanceManager = { GetCreatureAppearanceById: (): undefined => undefined };
  state.ActionFactory = { FromStruct: jest.fn(() => undefined) };
  state.TwoDAManager = { datatables: new Map() };
  state.GetDebugState = () => false;
  state.SaveGame = undefined;

  PartyManager.party = [];
  PartyManager.NPCS = {} as any;
  // A companion template saved by an older build still carries IsPC=1.
  PartyManager.NPCS[2] = { template: creatureTemplate('atton', 1) } as any;
  const protagonist = new ModulePlayer(creatureTemplate('exile', 1));
  protagonist.load();
  PartyManager.Player = protagonist;
  PartyManager.ActualPlayerTemplate = undefined;
  PartyManager.PlayerTemplate = undefined;
});

afterEach(() => jest.restoreAllMocks());

describe('IsPC marks the real protagonist', () => {
  test('a companion in control saves IsPC 0, even from a template that says 1', () => {
    const companion = PartyManager.SwitchPlayerCharacter(2)!;
    expect(companion.getTag()).toBe('atton');
    expect(companion.isPC).toBe(0);
    expect(isPCOf(companion.save())).toBe(0);
  });

  test('switching back to the protagonist saves IsPC 1', () => {
    PartyManager.SwitchPlayerCharacter(2);
    const protagonist = PartyManager.SwitchPlayerCharacter(-1)!;
    expect(protagonist).toBeInstanceOf(ModulePlayer);
    expect(protagonist.getTag()).toBe('exile');
    expect(protagonist.isPC).toBe(1);
    expect(isPCOf(protagonist.save())).toBe(1);
  });

  test('a save made while a companion is in control reloads the protagonist from pc.utc', () => {
    // SwitchPlayerCharacter exports the protagonist's template before handing over.
    const companion = PartyManager.SwitchPlayerCharacter(2)!;
    const pcUtc = PartyManager.ActualPlayerTemplate;
    expect(pcUtc.RootNode.getFieldByLabel('Tag').getValue()).toBe('exile');

    const ifo = new GFFObject(savegameIFO(companion.save()).getExportBuffer());
    state.SaveGame = { pc: pcUtc };
    loadSavegameModule(ifo);

    expect(PartyManager.PlayerTemplate.RootNode.getFieldByLabel('Tag').getValue()).toBe('atton');
    // Compared by tag and identity flag: jest cannot pretty-print a GFFObject diff.
    expect(PartyManager.ActualPlayerTemplate.RootNode.getFieldByLabel('Tag').getValue()).toBe('exile');
    expect(PartyManager.ActualPlayerTemplate === pcUtc).toBe(true);
  });

  test('a save made as the protagonist reloads it from Mod_PlayerList', () => {
    PartyManager.SwitchPlayerCharacter(2);
    const protagonist = PartyManager.SwitchPlayerCharacter(-1)!;
    const ifo = new GFFObject(savegameIFO(protagonist.save()).getExportBuffer());
    state.SaveGame = { pc: new GFFObject() };
    loadSavegameModule(ifo);

    expect(PartyManager.ActualPlayerTemplate === PartyManager.PlayerTemplate).toBe(true);
    expect(PartyManager.ActualPlayerTemplate.RootNode.getFieldByLabel('Tag').getValue()).toBe('exile');
  });
});

describe('a save made while a companion is in control survives save -> load -> save -> switch back', () => {
  let exported: Uint8Array | undefined;

  beforeEach(() => {
    state.GameKey = 'TSL';
    state.Planetary = { SaveStruct: () => new GFFStruct(), LoadStruct: jest.fn() };
    state.TutorialWindowTracker = [];
    const messages = () => ({ Entries: [] as any[], ClearEntries: jest.fn(), AddEntry: jest.fn(), SortOrder: 0 });
    state.JournalManager = messages();
    state.DialogMessageManager = messages();
    state.FeedbackMessageManager = messages();
    const cards = new Map();
    for(let i = 0; i < 19; i++){ cards.set(i, { card: i, count: 0 }); }
    state.PazaakManager = { Cards: cards, PlayerSideDeck: new Map() };
    state.time = 0;
    state.getCurrentPlayer = () => PartyManager.party[0] ?? PartyManager.Player;
    state.group = { party: { add: jest.fn() } };
    (CurrentGame as any).gameinprogress_dir = 'gip';
    state.FactionManager.RemoveCreatureFromFaction = jest.fn();
    jest.spyOn(GFFObject.prototype, 'export').mockImplementation(function(this: GFFObject, _file: string, onExport?: Function){
      exported = this.getExportBuffer();
      onExport?.();
      return Promise.resolve(this);
    });
  });

  async function exportControlledNPC(){
    await PartyManager.Export('save');
    return new GFFObject(exported).RootNode.getFieldByLabel('PT_CONTROLLED_NP').getValue();
  }

  /** ModuleArea.loadPlayer's real body, with the renderer-heavy imports stubbed. */
  async function areaLoadPlayer(){
    const { ModuleArea } = loadSourceWithStubs('module/ModuleArea.ts', {
      '@/GameState': { GameState },
      '@/module/ModuleCreature': { ModuleCreature },
      '@/module/ModulePlayer': { ModulePlayer },
      '@/resource/GFFField': { GFFField },
      '@/enums/resource/GFFDataType': { GFFDataType },
    });
    const area = Object.create(ModuleArea.prototype);
    area.miniGame = undefined;
    area.getSpawnLocation = () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 1, z: 0 } });
    (ModuleCreature.prototype.loadModel as jest.Mock).mockResolvedValueOnce({ userData: {} } as never);
    await area.loadPlayer();
  }

  test('controlled NPC preserved, protagonist template untouched', async () => {
    PartyManager.ResetPartyTableState();
    PartyManager.NPCS[2] = { template: creatureTemplate('atton', 0), available: true, canSelect: true, spawned: false };
    const companion = PartyManager.SwitchPlayerCharacter(2)!;
    PartyManager.party = [companion];
    const pcUtc = PartyManager.ActualPlayerTemplate;
    expect(PartyManager.GetControlledNPC()).toBe(2);
    expect(await exportControlledNPC()).toBe(2);
    const partytable = new GFFObject(exported);
    const ifo = new GFFObject(savegameIFO(companion.save()).getExportBuffer());

    // Load, the way SaveGame.load -> Module.setFromIFO -> ModuleArea.loadPlayer does it.
    PartyManager.Player = undefined;
    PartyManager.party = [];
    PartyManager.PlayerTemplate = undefined;
    PartyManager.ActualPlayerTemplate = undefined;
    await PartyManager.Load(partytable);
    state.SaveGame = { pc: pcUtc };
    loadSavegameModule(ifo);
    await areaLoadPlayer();

    const loaded = PartyManager.Player;
    expect(loaded).toBeInstanceOf(ModulePlayer);
    expect(loaded.getTag()).toBe('atton');
    expect(loaded.npcId).toBe(2);
    expect(loaded.isPC).toBe(0);
    expect(PartyManager.GetControlledNPC()).toBe(2);
    expect(PartyManager.IsProtagonist(loaded)).toBe(false);

    // Re-save keeps it, and keeps pc.utc as the protagonist.
    expect(await exportControlledNPC()).toBe(2);
    expect(PartyManager.ActualPlayerTemplate.RootNode.getFieldByLabel('Tag').getValue()).toBe('exile');

    // Switching back must not overwrite the protagonist with the companion.
    (CurrentGame.WriteFile as jest.Mock).mockClear();
    const back = PartyManager.SwitchPlayerCharacter(-1)!;
    expect(CurrentGame.WriteFile).not.toHaveBeenCalled();
    expect(back.getTag()).toBe('exile');
    expect(back.isPC).toBe(1);
    expect(PartyManager.ActualPlayerTemplate.RootNode.getFieldByLabel('Tag').getValue()).toBe('exile');
    PartyManager.party = [back];
    expect(PartyManager.GetControlledNPC()).toBe(-1);
    expect(await exportControlledNPC()).toBe(-1);
  });

  test('a protagonist save never relabels the player as a companion, even with a stale PT_CONTROLLED_NP', async () => {
    PartyManager.ResetPartyTableState();
    const partytable = new GFFObject();
    partytable.RootNode.addField(new GFFField(GFFDataType.DWORD, 'PT_GOLD')).setValue(0);
    // Pre-fix builds wrote the leader's party index here: 0 whenever any companion led.
    partytable.RootNode.addField(new GFFField(GFFDataType.INT, 'PT_CONTROLLED_NP')).setValue(0);
    await PartyManager.Load(partytable);
    PartyManager.Player = undefined;
    PartyManager.party = [];
    PartyManager.PlayerTemplate = creatureTemplate('exile', 1);
    await areaLoadPlayer();
    expect(PartyManager.Player.npcId).toBe(-1);
    expect(PartyManager.GetControlledNPC()).toBe(-1);
  });

  test('GetLoadedPlayerNPCId trusts PT_CONTROLLED_NP only for a non-protagonist template and a real NPC slot', () => {
    PartyManager.ResetPartyTableState();
    const noIsPC = new GFFObject();
    PartyManager.ControlledNPC = 3;
    expect(PartyManager.GetLoadedPlayerNPCId(creatureTemplate('atton', 0))).toBe(3);
    expect(PartyManager.GetLoadedPlayerNPCId(creatureTemplate('exile', 1))).toBe(-1);
    expect(PartyManager.GetLoadedPlayerNPCId(noIsPC)).toBe(-1); // chargen/generated templates carry no IsPC
    PartyManager.ControlledNPC = 12;
    expect(PartyManager.GetLoadedPlayerNPCId(creatureTemplate('atton', 0))).toBe(-1);
    PartyManager.ControlledNPC = -1;
    expect(PartyManager.GetLoadedPlayerNPCId(creatureTemplate('atton', 0))).toBe(-1);
  });

  test('loadPlayer reusing a live player (no dispose in between) keeps a controlled companion\'s slot', async () => {
    const companion = PartyManager.SwitchPlayerCharacter(2)!;
    PartyManager.party = [];
    jest.spyOn(companion, 'load').mockImplementation(() => {});
    (companion as any).collisionManager = {};
    await areaLoadPlayer();
    expect(PartyManager.Player).toBe(companion);
    expect(companion.npcId).toBe(2);
  });

  function realArea(){
    const { ModuleArea } = loadSourceWithStubs('module/ModuleArea.ts', {
      '@/GameState': { GameState },
      '@/module/ModuleCreature': { ModuleCreature },
      '@/module/ModulePlayer': { ModulePlayer },
      '@/resource/GFFField': { GFFField },
      '@/enums/resource/GFFDataType': { GFFDataType },
    });
    const area = Object.create(ModuleArea.prototype);
    area.miniGame = undefined;
    area.creatures = [];
    area.getSpawnLocation = () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 1, z: 0 } });
    return area;
  }

  /**
   * GameState.LoadModule: module.save() runs PartyManager.Save(), module.dispose() drops the player,
   * then the next area runs its real loadPlayer and loadParty.
   */
  async function moduleTransition(){
    PartyManager.Save();
    PartyManager.Player = undefined;
    PartyManager.party = [];
    (ModuleCreature.prototype.loadModel as jest.Mock).mockResolvedValue({ userData: {} } as never);
    jest.spyOn(ModuleCreature.prototype, 'onSpawn').mockImplementation(() => {});
    const THREE = jest.requireActual('three') as typeof import('three');
    jest.spyOn(PartyManager, 'GetSpawnLocation').mockImplementation(() => ({ position: new THREE.Vector3(), getFacing: () => 0 }) as any);
    jest.spyOn(PartyManager, 'RebuildPortraitOrder').mockImplementation(() => {});
    const area = realArea();
    await area.loadPlayer();
    await area.loadParty();
    // Back to the suite default: a later SwitchPlayerCharacter must not run its async model callback.
    (ModuleCreature.prototype.loadModel as jest.Mock).mockReturnValue(new Promise(() => {}) as never);
    return PartyManager.Player;
  }

  const roster = () => PartyManager.party.map((p) => p.getTag() + ':' + p.npcId + (p === PartyManager.Player ? '(P)' : ''));

  test('a transition with a companion in control loads it once, with the other companions', async () => {
    PartyManager.ResetPartyTableState();
    PartyManager.NPCS[2] = { template: creatureTemplate('atton', 0), available: true, canSelect: true, spawned: false };
    PartyManager.NPCS[5] = { template: creatureTemplate('bao', 0), available: true, canSelect: true, spawned: false };
    const atton = PartyManager.SwitchPlayerCharacter(2)!;
    const bao = new ModuleCreature(PartyManager.NPCS[5].template); bao.load(); bao.npcId = 5; bao.isPM = true;
    PartyManager.party = [atton, bao];
    PartyManager.CurrentMembers = [{ isLeader: false, memberID: 5 }];

    await moduleTransition();
    expect(roster()).toEqual(['atton:2(P)', 'bao:5']);
    // The companion in control stays listed, as the leader; CurrentMembers keeps join order (bao joined first).
    expect(PartyManager.CurrentMembers).toEqual([{ isLeader: false, memberID: 5 }, { isLeader: true, memberID: 2 }]);

    // and again: the duplicate must not come back on the next transition
    await moduleTransition();
    expect(roster()).toEqual(['atton:2(P)', 'bao:5']);
  });

  test('a transition with a companion in control, alone, loads just that companion', async () => {
    PartyManager.ResetPartyTableState();
    PartyManager.NPCS[2] = { template: creatureTemplate('atton', 0), available: true, canSelect: true, spawned: false };
    PartyManager.party = [PartyManager.SwitchPlayerCharacter(2)!];
    PartyManager.CurrentMembers = [];
    await moduleTransition();
    expect(roster()).toEqual(['atton:2(P)']);
  });

  test('a save that still lists the controlled companion in PT_MEMBERS does not spawn it twice', async () => {
    PartyManager.ResetPartyTableState();
    PartyManager.NPCS[2] = { template: creatureTemplate('atton', 0), available: true, canSelect: true, spawned: false };
    PartyManager.PlayerTemplate = creatureTemplate('atton', 0);
    PartyManager.ControlledNPC = 2;
    PartyManager.CurrentMembers = [{ isLeader: true, memberID: 2 }];
    PartyManager.Player = undefined;
    PartyManager.party = [];
    (ModuleCreature.prototype.loadModel as jest.Mock).mockResolvedValue({ userData: {} } as never);
    jest.spyOn(ModuleCreature.prototype, 'onSpawn').mockImplementation(() => {});
    const THREE = jest.requireActual('three') as typeof import('three');
    jest.spyOn(PartyManager, 'GetSpawnLocation').mockImplementation(() => ({ position: new THREE.Vector3(), getFacing: () => 0 }) as any);
    jest.spyOn(PartyManager, 'RebuildPortraitOrder').mockImplementation(() => {});
    const area = realArea();
    await area.loadPlayer();
    await area.loadParty();
    expect(roster()).toEqual(['atton:2(P)']);
  });

  test('neither RemoveNPCById nor the party selection screen can drop the companion in control', async () => {
    PartyManager.ResetPartyTableState();
    PartyManager.NPCS[2] = { template: creatureTemplate('atton', 0), available: true, canSelect: true, spawned: false };
    PartyManager.NPCS[5] = { template: creatureTemplate('bao', 0), available: true, canSelect: true, spawned: false };
    const atton = PartyManager.SwitchPlayerCharacter(2)!;
    
    PartyManager.party = [atton];
    PartyManager.Save();
    expect(PartyManager.CurrentMembers).toEqual([{ isLeader: true, memberID: 2 }]);

    const { MenuPartySelection } = loadSourceWithStubs('game/kotor/menu/MenuPartySelection.ts', { '@/GameState': { GameState } });
    const menu = Object.create(MenuPartySelection.prototype);
    menu.isNPCRequired = () => false;
    menu.isSelectable = () => true;
    // The screen must not offer to add the companion already in control...
    expect(menu.canAdd(2)).toBe(false);
    expect(menu.canAdd(5)).toBe(true);
    // ...and the manager must refuse it too.
    PartyManager.CurrentMembers = [];
    await PartyManager.AddNPCById(2);
    expect(PartyManager.CurrentMembers).toEqual([]);
    PartyManager.CurrentMembers = [{ isLeader: true, memberID: 2 }];

    expect(menu.canRemove(2)).toBe(false);
    expect(menu.getCurrentMemberCount()).toBe(0);
    PartyManager.RemoveNPCById(2, false);
    expect(PartyManager.party).toEqual([atton]);
    expect(atton.destroyed).toBe(false);
  });

  test('switching into a companion already in the party takes over that creature, no duplicate', () => {
    PartyManager.ResetPartyTableState();
    PartyManager.NPCS[2] = { template: creatureTemplate('atton', 0), available: true, canSelect: true, spawned: false };
    PartyManager.NPCS[5] = { template: creatureTemplate('bao', 0), available: true, canSelect: true, spawned: false };
    const exile = PartyManager.Player;
    
    jest.spyOn(PartyManager, 'RebuildPortraitOrder').mockImplementation(() => {});
    // An older companion template that still says IsPC=1: in control it must save 0.
    const attonPM = new ModuleCreature(creatureTemplate('atton', 1)); attonPM.load(); attonPM.npcId = 2; attonPM.isPM = true;
    expect(attonPM.isPC).toBe(1);
    const baoPM = new ModuleCreature(PartyManager.NPCS[5].template); baoPM.load(); baoPM.npcId = 5; baoPM.isPM = true;
    PartyManager.party = [exile, attonPM, baoPM];
    PartyManager.CurrentMembers = [{ isLeader: false, memberID: 2 }, { isLeader: false, memberID: 5 }];

    expect(PartyManager.SwitchPlayerCharacter(2)).toBe(attonPM);
    expect(roster()).toEqual(['atton:2(P)', 'bao:5']);
    expect(attonPM.isPC).toBe(0);
    // Out of the party now; the real destroy is deferred to the next tick.
    expect(exile.destroyed).toBe(false);
    expect(PartyManager.PendingDestroy).toContain(exile);
    PartyManager.FlushPendingDestroys();
    expect(exile.destroyed).toBe(true);
    expect(PartyManager.CurrentMembers).toEqual([{ isLeader: true, memberID: 2 }, { isLeader: false, memberID: 5 }]);
    expect(PartyManager.ActualPlayerTemplate.RootNode.getFieldByLabel('Tag').getValue()).toBe('exile');

    // companion -> companion: the previous one stays a member, the new one leads
    expect(PartyManager.SwitchPlayerCharacter(5)).toBe(baoPM);
    expect(roster()).toEqual(['bao:5(P)', 'atton:2']);
    expect(PartyManager.CurrentMembers).toEqual([{ isLeader: false, memberID: 2 }, { isLeader: true, memberID: 5 }]);
    expect(PartyManager.GetControlledNPC()).toBe(5);
  });

  function member(tag: string, slot: number){
    const c = new ModuleCreature(creatureTemplate(tag, 0)); c.load(); c.npcId = slot; c.isPM = true;
    
    return c;
  }
  async function flush(){ for(let i = 0; i < 10; i++) await Promise.resolve(); }
  /** The real ModuleArea.dispose on an otherwise empty area: destroys the party and flushes pending destroys. */
  function disposeArea(){
    const area = realArea();
    Object.assign(area, { rooms: [], areaOfEffects: [], creatures: [], items: [], placeables: [], doors: [], triggers: [],
      waypoints: [], sounds: [], encounters: [], stores: [], spellInstances: [], textSprites: [], weather: { destroy(){} } });
    area.dispose();
  }
  /** Let the deferred destroy of retired creatures (next tick) run. */
  const tick = () => new Promise((r) => setTimeout(r, 0));
  function resolveModels(){
    (ModuleCreature.prototype.loadModel as jest.Mock).mockResolvedValue({ userData: {} } as never);
    jest.spyOn(ModuleCreature.prototype, 'onSpawn').mockImplementation(() => {});
  }
  const memberIds = () => PartyManager.CurrentMembers.map((m) => m.memberID);

  describe('switching keeps every companion in the party', () => {
    beforeEach(() => {
      PartyManager.ResetPartyTableState();
      PartyManager.CurrentMembers = [];
      PartyManager.party = [PartyManager.Player];
      
      for(const [slot, tag] of [[2, 'carth'], [5, 'bastila'], [7, 'hk']] as const){
        PartyManager.NPCS[slot] = { template: creatureTemplate(tag, 0), available: true, canSelect: true, spawned: false };
      }
    });

    test('take over an in-party companion, then switch back: the companion stays, alive, with what it gained', async () => {
      const exile = PartyManager.Player;
      const carth = member('carth', 2), bastila = member('bastila', 5);
      PartyManager.party = [exile, carth, bastila];
      PartyManager.CurrentMembers = [{ isLeader: false, memberID: 2 }, { isLeader: false, memberID: 5 }];
      PartyManager.SwitchPlayerCharacter(2);
      carth.experience = 1234; // earned while in control

      resolveModels();
      const back = PartyManager.SwitchPlayerCharacter(-1)!;
      await flush();
      expect(back.getTag()).toBe('exile');
      expect(roster()).toEqual(['exile:-1(P)', 'carth:2', 'bastila:5']);
      expect(carth.destroyed).toBe(false);
      expect(memberIds()).toEqual([2, 5]);
      expect(routine(partyRoutines.IsNPCPartyMember, 'kotor')(2)).toBe(1);
      expect(PartyManager.NPCS[2].template.RootNode.getFieldByLabel('Experience').getValue()).toBe(1234);

      (ModuleCreature.prototype.loadModel as jest.Mock).mockReturnValue(new Promise(() => {}) as never);
      await moduleTransition();
      expect(roster()).toEqual(['exile:-1(P)', 'carth:2', 'bastila:5']);
    });

    test('switch to a non-party NPC while a companion leads: the leader stays a member, the protagonist leaves', async () => {
      const exile = PartyManager.Player;
      const carth = member('carth', 2), bastila = member('bastila', 5);
      PartyManager.party = [carth, exile, bastila];
      PartyManager.CurrentMembers = [{ isLeader: true, memberID: 2 }, { isLeader: false, memberID: 5 }];
      resolveModels();
      const hk = PartyManager.SwitchPlayerCharacter(7)!;
      expect(roster()).toEqual(['hk:7(P)', 'carth:2', 'bastila:5']); // synchronously, before the model loads
      await flush();
      expect(roster()).toEqual(['hk:7(P)', 'carth:2', 'bastila:5']);
      expect(PartyManager.party[0]).toBe(hk);
      await tick();
      expect(exile.destroyed).toBe(true);
      expect(carth.destroyed).toBe(false);
      expect(PartyManager.CurrentMembers).toEqual([{ isLeader: false, memberID: 2 }, { isLeader: false, memberID: 5 }, { isLeader: true, memberID: 7 }]);
      (ModuleCreature.prototype.loadModel as jest.Mock).mockReturnValue(new Promise(() => {}) as never);
    });

    test('take over a member while another companion leads: the taken-over creature leads', () => {
      const exile = PartyManager.Player;
      const carth = member('carth', 2), bastila = member('bastila', 5);
      PartyManager.party = [carth, exile, bastila];
      PartyManager.CurrentMembers = [{ isLeader: true, memberID: 2 }, { isLeader: false, memberID: 5 }];
      PartyManager.SwitchPlayerCharacter(5);
      expect(roster()).toEqual(['bastila:5(P)', 'carth:2']);
      expect(PartyManager.CurrentMembers).toEqual([{ isLeader: false, memberID: 2 }, { isLeader: true, memberID: 5 }]);
      expect(state.currentLeader).toBe(bastila);
    });

    test('a taken-over companion stays a member when control moves on to a non-party NPC', async () => {
      const exile = PartyManager.Player;
      const carth = member('carth', 2), bastila = member('bastila', 5);
      PartyManager.party = [exile, carth, bastila];
      PartyManager.CurrentMembers = [{ isLeader: false, memberID: 2 }, { isLeader: false, memberID: 5 }];
      PartyManager.SwitchPlayerCharacter(2);
      resolveModels();
      PartyManager.SwitchPlayerCharacter(7);
      await flush();
      expect(roster()).toEqual(['hk:7(P)', 'carth:2', 'bastila:5']);
      expect(carth.destroyed).toBe(false);
      expect(memberIds()).toEqual([2, 5, 7]);
      (ModuleCreature.prototype.loadModel as jest.Mock).mockReturnValue(new Promise(() => {}) as never);
    });

    test('the companion in control is a party member to scripts; an Ebon Hawk spawn loop does not copy it', () => {
      const carth = PartyManager.SwitchPlayerCharacter(2)!;
      expect(routine(partyRoutines.IsNPCPartyMember, 'kotor')(2)).toBe(1);
      expect(routine(partyRoutines.IsObjectPartyMember, 'kotor')(carth)).toBe(1);
      const spawned: number[] = [];
      for(let i = 0; i < PartyManager.MaxPartyCount; i++){
        if(PartyManager.IsAvailable(i) && !routine(partyRoutines.IsNPCPartyMember, 'kotor')(i)) spawned.push(i);
      }
      expect(spawned).toEqual([5, 7]);
    });

    test('a companion-only segment: switch to a non-party NPC, then add two companions in the same script', async () => {
      state.module = { area: { creatures: [] } };
      resolveModels();
      PartyManager.party = [PartyManager.Player];
      PartyManager.SwitchPlayerCharacter(2);
      const add = routine(partyRoutines.AddPartyMember, 'kotor');
      const bao = member('bao', -1), mand = member('mand', -1);
      bao.npcId = undefined; mand.npcId = undefined;
      expect(add(4, bao)).toBe(1);
      expect(add(6, mand)).toBe(1);
      expect(add(5, member('extra', -1))).toBe(0);
      await flush();
      expect(roster()).toEqual(['carth:2(P)', 'bao:4', 'mand:6']);
      expect(memberIds()).toEqual([2, 4, 6]);
      (ModuleCreature.prototype.loadModel as jest.Mock).mockReturnValue(new Promise(() => {}) as never);
    });

    test('a controlled companion an older save left out of PT_MEMBERS rejoins as a member on switching back', () => {
      const carth = member('carth', 2);
      PartyManager.Player = carth;
      PartyManager.party = [carth];
      PartyManager.CurrentMembers = [];
      PartyManager.ActualPlayerTemplate = creatureTemplate('exile', 1);
      PartyManager.SwitchPlayerCharacter(-1);
      expect(roster()).toEqual(['exile:-1(P)', 'carth:2']);
      expect(PartyManager.CurrentMembers).toEqual([{ isLeader: false, memberID: 2 }]);
    });

    test('the PARTYTABLE lists the companion in control in PT_MEMBERS, flagged as leader', async () => {
      PartyManager.SwitchPlayerCharacter(2);
      await PartyManager.Export('save');
      const rows = new GFFObject(exported).RootNode.getFieldByLabel('PT_MEMBERS').getChildStructs()
        .map((s) => [s.getFieldByLabel('PT_MEMBER_ID').getValue(), s.getFieldByLabel('PT_IS_LEADER').getValue()]);
      expect(rows).toEqual([[2, 1]]);
    });

    test('switching to the companion already in control is a no-op', () => {
      const first = PartyManager.SwitchPlayerCharacter(2)!;
      expect(PartyManager.SwitchPlayerCharacter(2)).toBe(first);
      expect(roster()).toEqual(['carth:2(P)']);
      expect(memberIds()).toEqual([2]);
    });

    test('switching to an invalid slot changes nothing', () => {
      const exile = PartyManager.Player;
      expect(PartyManager.SwitchPlayerCharacter(12)).toBeUndefined();
      expect(PartyManager.SwitchPlayerCharacter(-5)).toBeUndefined();
      expect(PartyManager.Player).toBe(exile);
      expect(PartyManager.party).toEqual([exile]);
    });

    test('a slotless follower in the party does not take a companion seat', () => {
      state.module = { area: { creatures: [] } };
      const carth = member('carth', 2);
      const follower = member('follower', -1); follower.npcId = undefined;
      PartyManager.party = [PartyManager.Player, carth, follower];
      PartyManager.CurrentMembers = [{ isLeader: false, memberID: 2 }];
      expect(PartyManager.AddCreatureToParty(5, member('bastila', 5))).toBe(true);
      expect(PartyManager.GetCompanionMemberCount()).toBe(2);
    });

    test('UpdateLeader on an empty party clears every leader flag without throwing', () => {
      PartyManager.party = [];
      PartyManager.CurrentMembers = [{ isLeader: true, memberID: 2 }];
      expect(() => PartyManager.UpdateLeader()).not.toThrow();
      expect(PartyManager.CurrentMembers).toEqual([{ isLeader: false, memberID: 2 }]);
    });

    /** Switch to non-party NPC 2, then AddPartyMember 4 and 6 in the same script: controlled + 2, protagonist out. */
    async function companionOnlySegment(){
      state.module = { area: { creatures: [] } };
      resolveModels();
      PartyManager.party = [PartyManager.Player];
      PartyManager.SwitchPlayerCharacter(2);
      const add = routine(partyRoutines.AddPartyMember, 'kotor');
      const bao = member('bao', -1), mand = member('mand', -1);
      bao.npcId = undefined; mand.npcId = undefined;
      expect(add(4, bao)).toBe(1);
      expect(add(6, mand)).toBe(1);
      await flush();
      PartyManager.NPCS[4].template = bao.save();
      PartyManager.NPCS[6].template = mand.save();
      return { bao, mand };
    }
    const count = () => routine(partyRoutines.GetPartyMemberCount, 'kotor')();

    test('a companion-only segment of three survives a module transition', async () => {
      await companionOnlySegment();
      await moduleTransition();
      expect(roster()).toEqual(['carth:2(P)', 'bao:4', 'mand:6']);
      expect(memberIds()).toEqual([2, 4, 6]);
    });

    test('a full party switched to a non-party NPC keeps both companions through a transition', async () => {
      const exile = PartyManager.Player;
      const carth = member('carth', 2), bastila = member('bastila', 5);
      PartyManager.party = [exile, carth, bastila];
      PartyManager.CurrentMembers = [{ isLeader: false, memberID: 2 }, { isLeader: false, memberID: 5 }];
      resolveModels();
      PartyManager.SwitchPlayerCharacter(7);
      await flush();
      await moduleTransition();
      expect(roster()).toEqual(['hk:7(P)', 'carth:2', 'bastila:5']);
    });

    test('switching back to the protagonist with three companions keeps the party at three', async () => {
      const { bao, mand } = await companionOnlySegment();
      mand.experience = 77; // earned after joining; must be in the slot template when it leaves
      PartyManager.ActualPlayerTemplate = creatureTemplate('exile', 1);
      PartyManager.SwitchPlayerCharacter(-1);
      await flush();
      // The previously controlled companion stays; the most recently joined one leaves but stays available.
      expect(roster()).toEqual(['exile:-1(P)', 'carth:2', 'bao:4']);
      expect(count()).toBe(3);
      expect(memberIds()).toEqual([2, 4]);
      await tick();
      expect(mand.destroyed).toBe(true);
      expect(bao.destroyed).toBe(false);
      expect(PartyManager.IsAvailable(6)).toBe(true);
      expect(PartyManager.NPCS[6].template.RootNode.getFieldByLabel('Tag').getValue()).toBe('mand');
      expect(PartyManager.NPCS[6].template.RootNode.getFieldByLabel('Experience').getValue()).toBe(77);

      (ModuleCreature.prototype.loadModel as jest.Mock).mockReturnValue(new Promise(() => {}) as never);
      await moduleTransition();
      expect(roster()).toEqual(['exile:-1(P)', 'carth:2', 'bao:4']);
    });

    function stubSpawnLocation(){
      const THREE = jest.requireActual('three') as typeof import('three');
      jest.spyOn(PartyManager, 'GetSpawnLocation').mockImplementation(() => ({ position: new THREE.Vector3(), getFacing: () => 0 }) as any);
    }

    test('the party selection screen adds members while a companion is in control without leaving holes', async () => {
      resolveModels();
      stubSpawnLocation();
      PartyManager.SwitchPlayerCharacter(2);
      await flush();
      await PartyManager.AddNPCById(5);
      expect(PartyManager.party.map((p) => p?.getTag())).toEqual(['carth', 'bastila']);
      expect(count()).toBe(2);
      expect(routine(partyRoutines.GetPartyMemberByIndex, 'kotor')(1)?.getTag()).toBe('bastila');
      expect(PartyManager.GetPartyMemberByNPCId(9)).toBeNull();

      await PartyManager.AddNPCById(7);
      expect(PartyManager.party.map((p) => p?.getTag())).toEqual(['carth', 'bastila', 'hk']);
      expect(routine(partyRoutines.IsNPCPartyMember, 'kotor')(7)).toBe(1);
    });

    test('LoadPartyMember never grows the world party past three', async () => {
      resolveModels();
      stubSpawnLocation();
      const carth = member('carth', 2), bastila = member('bastila', 5);
      PartyManager.party = [PartyManager.Player, carth, bastila];
      PartyManager.CurrentMembers = [{ isLeader: false, memberID: 2 }, { isLeader: false, memberID: 5 }, { isLeader: false, memberID: 7 }];
      await PartyManager.LoadPartyMember(2);
      expect(PartyManager.party).toEqual([PartyManager.Player, carth, bastila]);
    });

    test('a module transition while the switch\'s model loads neither leaks the protagonist nor runs on a disposed companion', async () => {
      const exile = PartyManager.Player;
      const resolvers: Function[] = [];
      (ModuleCreature.prototype.loadModel as jest.Mock).mockImplementation(function(this: any){
        // The real loadModel resolves with this.model, undefined once the creature was destroyed mid-load.
        return new Promise((r) => resolvers.push(() => r(this.destroyed ? this.model : { userData: {} }))) as any;
      });
      const onSpawn = jest.spyOn(ModuleCreature.prototype, 'onSpawn').mockImplementation(() => {});
      const carth = PartyManager.SwitchPlayerCharacter(2)!;
      expect(exile.destroyed).toBe(false); // deferred: the running script may still address it
      PartyManager.Save();
      disposeArea(); // the real ModuleArea.dispose
      expect(exile.destroyed).toBe(true); // flushed by the transition, not leaked
      const unhandled: any[] = [];
      const onUnhandled = (e: any) => unhandled.push(String(e));
      process.on('unhandledRejection', onUnhandled);
      resolvers.forEach((r) => r());
      await flush(); await new Promise((r) => setTimeout(r, 10));
      process.off('unhandledRejection', onUnhandled);
      expect(carth.destroyed).toBe(true);
      expect(onSpawn).not.toHaveBeenCalled();
      expect(state.group.party.add).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    });

    test('a failed model load during a switch is reported, not left as an unhandled rejection', async () => {
      (ModuleCreature.prototype.loadModel as jest.Mock).mockReturnValue(Promise.reject(new Error('bad appearance')) as never);
      const unhandled: any[] = [];
      const onUnhandled = (e: any) => unhandled.push(String(e));
      process.on('unhandledRejection', onUnhandled);
      const carth = PartyManager.SwitchPlayerCharacter(2)!;
      await flush(); await new Promise((r) => setTimeout(r, 10));
      process.off('unhandledRejection', onUnhandled);
      expect(unhandled).toEqual([]);
      expect(PartyManager.Player).toBe(carth);
      expect(console.error).toHaveBeenCalledWith('SwitchPlayerCharacter: model load failed', 2, expect.any(Error));
    });

    test('over capacity on switching back, the previously controlled companion stays even if it joined last', async () => {
      state.module = { area: { creatures: [] } };
      resolveModels();
      const bao = member('bao', 4), mand = member('mand', 6);
      PartyManager.party = [PartyManager.Player, bao, mand];
      PartyManager.CurrentMembers = [{ isLeader: false, memberID: 4 }, { isLeader: false, memberID: 6 }];
      PartyManager.SwitchPlayerCharacter(2); // carth joins as the controlled companion, listed last
      await flush();
      expect(memberIds()).toEqual([4, 6, 2]);
      PartyManager.SwitchPlayerCharacter(-1);
      await flush();
      expect(roster()).toEqual(['exile:-1(P)', 'carth:2', 'bao:4']);
      await tick();
      expect(mand.destroyed).toBe(true);
    });

    test('a deferred destroy that throws neither aborts the switch nor stops the other pending destroys', () => {
      const exile = PartyManager.Player;
      (exile as any).destroy = () => { throw new Error('renderer gone'); };
      const other = member('stray', 9);
      const carth = PartyManager.SwitchPlayerCharacter(2)!;
      expect(PartyManager.Player).toBe(carth);
      expect(roster()).toEqual(['carth:2(P)']);
      PartyManager.RetireCreature(other);
      expect(() => PartyManager.FlushPendingDestroys()).not.toThrow();
      expect(other.destroyed).toBe(true);
      expect(PartyManager.PendingDestroy).toEqual([]);
    });

    test('with the REAL destroy, a script that switches control can still address the old PC; it is destroyed next tick', async () => {
      (ModuleCreature.prototype.destroy as jest.Mock).mockRestore();
      state.ModuleObjectManager.RemoveObject = jest.fn();
      state.CursorManager = { notifyObjectDestroyed: jest.fn() };
      state.ActionFactory.ActionDoCommand = class { params: any[] = []; setParameter(i: number, _t: number, v: any){ this.params[i] = v; } dispose(){} };
      const exile = PartyManager.Player;
      if((exile as any).debugLabel){ (exile as any).debugLabel.dispose = () => {}; }
      const scene = new (jest.requireActual('three') as typeof import('three')).Object3D();
      scene.add(exile.container);

      // object oPC = GetFirstPC(); SwitchPlayerCharacter(2); AssignCommand(oPC, ActionDoCommand(...));
      const oPC = routine(require('@/nwscript/builtins/objects/party').GetFirstPC, 'tsl')();
      expect(oPC).toBe(exile);
      PartyManager.SwitchPlayerCharacter(2);
      const assigned = { offset: 0, script: { caller: undefined as any, seekTo(){}, runScript(){ this.caller.doCommand({ name: 'k_follow' }); } } };
      const { AssignCommand } = require('@/nwscript/builtins/scripting');
      expect(() => routine(AssignCommand, 'tsl')(oPC, assigned)).not.toThrow();
      expect(exile.actionQueue.length).toBe(1);
      expect(PartyManager.party.includes(exile)).toBe(false);
      expect(exile.isPM).toBe(false);
      expect(exile.container.parent).toBeNull(); // out of the scene: not rendered, not pickable
      expect(exile.destroyed).toBe(false);

      await tick();
      expect(console.error).not.toHaveBeenCalledWith('FlushPendingDestroys: failed to destroy', expect.anything());
      expect(exile.destroyed).toBe(true);
      expect(exile.actionQueue).toBeUndefined();
      // A later script still holding the dead PC: no-op, no throw.
      expect(() => exile.doCommand({} as any)).not.toThrow();
      expect(() => routine(require('@/nwscript/builtins/scripting').ActionDoCommand, 'tsl', exile)({ script: {} })).not.toThrow();
    });

    test('with the REAL destroy, a transition during the deferral destroys the old PC', () => {
      (ModuleCreature.prototype.destroy as jest.Mock).mockRestore();
      state.ModuleObjectManager.RemoveObject = jest.fn();
      state.CursorManager = { notifyObjectDestroyed: jest.fn() };
      const exile = PartyManager.Player;
      if((exile as any).debugLabel){ (exile as any).debugLabel.dispose = () => {}; }
      const carth = PartyManager.SwitchPlayerCharacter(2)!;
      if((carth as any).debugLabel){ (carth as any).debugLabel.dispose = () => {}; }
      PartyManager.Save();
      disposeArea();
      expect(exile.destroyed).toBe(true);
      expect(exile.actionQueue).toBeUndefined();
      expect(PartyManager.PendingDestroy).toEqual([]);
    });

    test('the switched-in creature appears where the outgoing one stood', () => {
      const exile = PartyManager.Player;
      exile.position.set(12, -4, 3);
      exile.quaternion.set(0, 0, 0.6, 0.8);
      const carth = PartyManager.SwitchPlayerCharacter(2)!;
      expect([carth.position.x, carth.position.y, carth.position.z]).toEqual([12, -4, 3]);
      expect([carth.quaternion.z, carth.quaternion.w]).toEqual([0.6, 0.8]);
    });

    test('switching with no player creature (no module loaded) is refused', () => {
      PartyManager.Player = undefined;
      PartyManager.party = [];
      expect(PartyManager.SwitchPlayerCharacter(2)).toBeUndefined();
      expect(PartyManager.Player).toBeUndefined();
      expect(PartyManager.party).toEqual([]);
    });

    test('a dropped companion re-created in the same script keeps its object-id registration (real ObjectManager + destroy)', async () => {
      const { ModuleObjectManager } = jest.requireActual('@/managers/ModuleObjectManager') as any;
      ModuleObjectManager.Reset();
      state.ModuleObjectManager = ModuleObjectManager;
      state.CursorManager = { notifyObjectDestroyed: jest.fn() };
      (ModuleCreature.prototype.destroy as jest.Mock).mockRestore();
      await companionOnlySegment();
      const carth = PartyManager.Player;
      if((carth as any).debugLabel){ (carth as any).debugLabel.dispose = () => {}; }
      PartyManager.SwitchPlayerCharacter(7);                   // over capacity: carth (outgoing) retired, destroy pending
      expect(PartyManager.NPCS[2].template.RootNode.hasField('ObjectId')).toBe(false);
      const carth2 = PartyManager.SwitchPlayerCharacter(2)!;   // same script: back to carth, rebuilt from the slot template
      if((carth2 as any).debugLabel){ (carth2 as any).debugLabel.dispose = () => {}; }
      expect(carth2).not.toBe(carth);
      await flush();
      expect(ModuleObjectManager.GetObjectById(carth2.id)).toBe(carth2);
      await tick();
      expect(carth.destroyed).toBe(true);
      expect(ModuleObjectManager.GetObjectById(carth2.id)).toBe(carth2);
      (ModuleCreature.prototype.loadModel as jest.Mock).mockReturnValue(new Promise(() => {}) as never);
    });

    test('ModuleObjectManager.RemoveObject never unregisters a different object that holds the same id', () => {
      const { ModuleObjectManager } = jest.requireActual('@/managers/ModuleObjectManager') as any;
      ModuleObjectManager.Reset();
      state.CursorManager = { notifyObjectDestroyed: jest.fn() };
      const live = { id: 42 }, stale = { id: 42 };
      ModuleObjectManager.ObjectList.set(42, live);
      ModuleObjectManager.RemoveObject(stale);
      expect(ModuleObjectManager.GetObjectById(42)).toBe(live);
      ModuleObjectManager.RemoveObject(live);
      expect(ModuleObjectManager.GetObjectById(42)).toBeUndefined();
    });

    test('a dropped companion\'s slot template carries no object id or action queue', async () => {
      await companionOnlySegment();
      const carth = PartyManager.Player;
      carth.template.RootNode.addField(new GFFField(GFFDataType.LIST, 'ActionList'));
      PartyManager.SwitchPlayerCharacter(7);
      const t = PartyManager.NPCS[2].template.RootNode;
      expect([t.hasField('ObjectId'), t.hasField('ActionList'), t.getFieldByLabel('Tag').getValue()]).toEqual([false, false, 'carth']);
      (ModuleCreature.prototype.loadModel as jest.Mock).mockReturnValue(new Promise(() => {}) as never);
    });

    test('portrait order follows the party after an over-capacity drop', async () => {
      const { bao, mand } = await companionOnlySegment();
      const carth = PartyManager.Player;
      const portrait = (resref: string) => ({ getPortraitGoodEvil: () => resref });
      (carth as any).portrait = portrait('po_carth'); (bao as any).portrait = portrait('po_bao'); (mand as any).portrait = portrait('po_mand');
      resolveModels();
      const hk = PartyManager.SwitchPlayerCharacter(7)!;
      (hk as any).portrait = portrait('po_hk');
      PartyManager.UpdateLeader();
      expect(PartyManager.PortraitOrder).toEqual(['po_hk', 'po_bao', 'po_mand']);
      (ModuleCreature.prototype.loadModel as jest.Mock).mockReturnValue(new Promise(() => {}) as never);
    });

    test('slotless followers take no seat: switching back keeps them and drops nobody', async () => {
      const carth = member('carth', 2), bao = member('bao', 4);
      const follower = member('follower', -1); follower.npcId = undefined;
      PartyManager.party = [PartyManager.Player, bao, follower];
      PartyManager.CurrentMembers = [{ isLeader: false, memberID: 4 }];
      PartyManager.SwitchPlayerCharacter(2); // protagonist out: carth, bao, follower
      expect(PartyManager.GetOccupiedSeatCount()).toBe(2);
      PartyManager.ActualPlayerTemplate = creatureTemplate('exile', 1);
      PartyManager.SwitchPlayerCharacter(-1);
      expect(PartyManager.GetOccupiedSeatCount()).toBe(3);
      expect(PartyManager.party.map((p) => p.getTag()).sort()).toEqual(['bao', 'carth', 'exile', 'follower']);
      await tick();
      expect([carth, bao, follower].some((c) => c.destroyed)).toBe(false);
    });

    test('AddNPCById and AddPartyMember share one seat rule: followers don\'t count, companions do', async () => {
      resolveModels();
      stubSpawnLocation();
      const carth = member('carth', 2);
      const follower = member('follower', -1); follower.npcId = undefined;
      PartyManager.party = [PartyManager.Player, carth, follower];
      PartyManager.CurrentMembers = [{ isLeader: false, memberID: 2 }];
      // Two adds in one script, the first not awaited: only the slot count can stop the second.
      const first = PartyManager.AddNPCById(5);
      const second = PartyManager.AddNPCById(7);
      await Promise.all([first, second]);
      expect(memberIds()).toEqual([2, 5]);
      expect(PartyManager.party.map((p) => p.getTag()).sort()).toEqual(['bastila', 'carth', 'exile', 'follower']);
      expect(routine(partyRoutines.IsNPCPartyMember, 'kotor')(7)).toBe(0);
    });

    test('switching between companions over capacity drops the outgoing companion, not one a script just added', async () => {
      const { bao, mand } = await companionOnlySegment();
      const carth = PartyManager.Player;
      PartyManager.SwitchPlayerCharacter(7);
      await flush();
      expect(roster()).toEqual(['hk:7(P)', 'bao:4', 'mand:6']);
      expect(memberIds()).toEqual([4, 6, 7]);
      await tick();
      expect(carth.destroyed).toBe(true);
      expect(bao.destroyed || mand.destroyed).toBe(false);
      expect(PartyManager.IsAvailable(2)).toBe(true);
      expect(PartyManager.NPCS[2].template.RootNode.getFieldByLabel('Tag').getValue()).toBe('carth');
      (ModuleCreature.prototype.loadModel as jest.Mock).mockReturnValue(new Promise(() => {}) as never);
    });

    test('join order survives a party reorder, a transition and a PARTYTABLE save, and decides who leaves', async () => {
      const { bao, mand } = await companionOnlySegment();
      // Reorder the world party (e.g. a leader change): join order must not follow it.
      PartyManager.party = [PartyManager.Player, mand, bao];
      await moduleTransition();
      expect(memberIds()).toEqual([2, 4, 6]);
      PartyManager.party = [PartyManager.party[0], ...PartyManager.party.slice(1).reverse()];
      await PartyManager.Export('save');
      const ids = new GFFObject(exported).RootNode.getFieldByLabel('PT_MEMBERS').getChildStructs().map((s) => s.getFieldByLabel('PT_MEMBER_ID').getValue());
      expect(ids).toEqual([2, 4, 6]);
      PartyManager.ActualPlayerTemplate = creatureTemplate('exile', 1);
      PartyManager.SwitchPlayerCharacter(-1);
      await flush();
      expect(roster().sort()).toEqual(['bao:4', 'carth:2', 'exile:-1(P)']); // mand joined last
    });

    test('AddNPCById on a full party lists nobody (no phantom member)', async () => {
      resolveModels();
      stubSpawnLocation();
      const carth = member('carth', 2), bastila = member('bastila', 5);
      PartyManager.party = [PartyManager.Player, carth, bastila];
      PartyManager.CurrentMembers = [{ isLeader: false, memberID: 2 }, { isLeader: false, memberID: 5 }];
      await PartyManager.AddNPCById(7);
      expect(memberIds()).toEqual([2, 5]);
      expect(routine(partyRoutines.IsNPCPartyMember, 'kotor')(7)).toBe(0);
    });

    test('loadParty keeps going past a member whose slot has no template', async () => {
      resolveModels();
      stubSpawnLocation();
      jest.spyOn(PartyManager, 'RebuildPortraitOrder').mockImplementation(() => {});
      PartyManager.NPCS[2].template = undefined;
      PartyManager.CurrentMembers = [{ isLeader: false, memberID: 2 }, { isLeader: false, memberID: 5 }];
      await realArea().loadParty();
      expect(PartyManager.party.map((p) => p.getTag())).toEqual(['exile', 'bastila']);
    });

    test('loadPlayer with the player still alive places it without holes', async () => {
      const exile = PartyManager.Player;
      jest.spyOn(exile, 'load').mockImplementation(() => {});
      (exile as any).collisionManager = {};
      PartyManager.party = [];
      PartyManager.CurrentMembers = [{ isLeader: true, memberID: 5 }];
      await areaLoadPlayer();
      expect(PartyManager.party).toEqual([exile]);
    });

    test('a model that resolves to nothing is skipped quietly', async () => {
      (ModuleCreature.prototype.loadModel as jest.Mock).mockResolvedValue(undefined as never);
      const onSpawn = jest.spyOn(ModuleCreature.prototype, 'onSpawn').mockImplementation(() => {});
      PartyManager.SwitchPlayerCharacter(2);
      await flush();
      expect(onSpawn).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalledWith('SwitchPlayerCharacter: model load failed', 2, expect.anything());
    });

    test('SavePartyMember tolerates a hole in the party', async () => {
      PartyManager.party = [undefined as any, member('carth', 2)];
      await expect(PartyManager.SavePartyMember(9)).resolves.toBeUndefined();
    });

    test('a model that resolves after the switched-in creature was destroyed is not added to the scene', async () => {
      const resolvers: Function[] = [];
      (ModuleCreature.prototype.loadModel as jest.Mock).mockImplementation(() => new Promise((r) => resolvers.push(() => r({ userData: {} }))) as any);
      const onSpawn = jest.spyOn(ModuleCreature.prototype, 'onSpawn').mockImplementation(() => {});
      const carth = PartyManager.SwitchPlayerCharacter(2)!;
      carth.destroy();
      resolvers.forEach((r) => r());
      await flush();
      expect(onSpawn).not.toHaveBeenCalled();
      expect(state.group.party.add).not.toHaveBeenCalled();
    });

    test('party placement never leaves holes, and lookups survive one if it exists', () => {
      const carth = member('carth', 2), bastila = member('bastila', 5), hk = member('hk', 7);
      PartyManager.party = [carth, undefined as any, bastila];
      expect(PartyManager.GetPartyMemberByNPCId(9)).toBeNull();
      expect(PartyManager.GetPMByNPCId(9)).toBeUndefined();
      PartyManager.PlaceInParty(hk, 7);
      expect(PartyManager.party).toEqual([carth, bastila, hk]);
      PartyManager.PlaceInParty(hk, 0);
      expect(PartyManager.party).toEqual([hk, carth, bastila]);
    });

    test('loadPlayer leaves no hole when the saved leader is a companion still to be loaded', async () => {
      PartyManager.PlayerTemplate = creatureTemplate('exile', 1);
      PartyManager.CurrentMembers = [{ isLeader: true, memberID: 5 }];
      PartyManager.Player = undefined;
      PartyManager.party = [];
      await areaLoadPlayer();
      expect(PartyManager.party.length).toBe(1);
      expect(PartyManager.party[0]).toBe(PartyManager.Player);
    });

    test('taking over an in-party companion clears its queued actions', () => {
      const carth = member('carth', 2);
      PartyManager.party = [PartyManager.Player, carth];
      PartyManager.CurrentMembers = [{ isLeader: false, memberID: 2 }];
      (ModuleCreature.prototype.clearAllActions as jest.Mock).mockClear();
      PartyManager.SwitchPlayerCharacter(2);
      expect((ModuleCreature.prototype.clearAllActions as jest.Mock).mock.contexts).toContain(carth);
    });

    test('re-slotting a member (2 -> 3) unbinds slot 2 so nothing can spawn a second copy', () => {
      state.module = { area: { creatures: [] } };
      const carth = member('carth', 2);
      PartyManager.party = [PartyManager.Player, carth];
      PartyManager.CurrentMembers = [{ isLeader: false, memberID: 2 }];
      expect(PartyManager.AddCreatureToParty(3, carth)).toBe(true);
      expect(PartyManager.NPCS[2]).toMatchObject({ available: false, canSelect: false, template: undefined, moduleObject: undefined });
      expect(PartyManager.IsAvailable(2)).toBe(false);
      expect(memberIds()).toEqual([3]);
    });
  });

  test('a slotless player whose template is not the protagonist\'s keeps IsPC 0 and cannot overwrite pc.utc', async () => {
    PartyManager.ResetPartyTableState();
    PartyManager.ControlledNPC = -1;
    PartyManager.PlayerTemplate = creatureTemplate('droid_t3', 0);
    const exile = PartyManager.ActualPlayerTemplate = creatureTemplate('exile', 1);
    PartyManager.Player = undefined;
    await areaLoadPlayer();
    expect(PartyManager.Player.isPC).toBe(0);
    expect(PartyManager.IsProtagonist(PartyManager.Player)).toBe(false);
    PartyManager.Player.save();
    expect(PartyManager.ActualPlayerTemplate === exile).toBe(true);
  });

  test('a companion in control stays that companion across a real module transition (fresh game)', async () => {
    PartyManager.ResetPartyTableState();
    PartyManager.NPCS[2] = { template: creatureTemplate('atton', 0), available: true, canSelect: true, spawned: false };
    PartyManager.party = [PartyManager.SwitchPlayerCharacter(2)!];
    const exile = PartyManager.ActualPlayerTemplate;
    expect(exile.RootNode.getFieldByLabel('Tag').getValue()).toBe('exile');

    const after = await moduleTransition();
    expect(after.getTag()).toBe('atton');
    expect(after.npcId).toBe(2);
    expect(PartyManager.IsProtagonist(after)).toBe(false);
    after.save();
    expect(PartyManager.ActualPlayerTemplate === exile).toBe(true);

    (CurrentGame.WriteFile as jest.Mock).mockClear();
    const back = PartyManager.SwitchPlayerCharacter(-1)!;
    expect(CurrentGame.WriteFile).not.toHaveBeenCalled();
    expect(back.getTag()).toBe('exile');
  });

  test('SwitchPlayerCharacter keeps ControlledNPC in step with the companion in control', () => {
    PartyManager.ResetPartyTableState();
    PartyManager.NPCS[2] = { template: creatureTemplate('atton', 0), available: true, canSelect: true, spawned: false };
    PartyManager.ControlledNPC = 7; // stale, from a loaded save
    PartyManager.SwitchPlayerCharacter(2);
    expect(PartyManager.ControlledNPC).toBe(2);
    PartyManager.SwitchPlayerCharacter(-1);
    expect(PartyManager.ControlledNPC).toBe(-1);
  });

  test('a stale PT_CONTROLLED_NP never relabels the companion switched into later', async () => {
    PartyManager.ResetPartyTableState();
    PartyManager.NPCS[2] = { template: creatureTemplate('atton', 0), available: true, canSelect: true, spawned: false };
    PartyManager.NPCS[5] = { template: creatureTemplate('bao', 0), available: true, canSelect: true, spawned: false };
    PartyManager.ControlledNPC = 2; // loaded from a save made while Atton was in control
    PartyManager.ActualPlayerTemplate = creatureTemplate('exile', 1);
    PartyManager.party = [PartyManager.SwitchPlayerCharacter(5)!];

    const after = await moduleTransition();
    after.save();
    expect(after.getTag()).toBe('bao');
    expect(after.npcId).toBe(5);
    expect(PartyManager.NPCS[2].template.RootNode.getFieldByLabel('Tag').getValue()).toBe('atton');
    expect(PartyManager.NPCS[5].template.RootNode.getFieldByLabel('Tag').getValue()).toBe('bao');
    expect(PartyManager.GetControlledNPC()).toBe(5);
  });

  test('switching back to the protagonist before a transition reloads the protagonist', async () => {
    PartyManager.ResetPartyTableState();
    PartyManager.NPCS[2] = { template: creatureTemplate('atton', 0), available: true, canSelect: true, spawned: false };
    PartyManager.party = [PartyManager.SwitchPlayerCharacter(2)!];
    PartyManager.party = [PartyManager.SwitchPlayerCharacter(-1)!];
    const after = await moduleTransition();
    expect(after.getTag()).toBe('exile');
    expect(after.npcId).toBe(-1);
    expect(PartyManager.IsProtagonist(after)).toBe(true);
  });

  test('an older save whose protagonist carries no IsPC still reloads as the protagonist', async () => {
    PartyManager.ResetPartyTableState();
    const noIsPC = new GFFObject();
    noIsPC.RootNode.addField(new GFFField(GFFDataType.CEXOSTRING, 'Tag')).setValue('revan');
    PartyManager.PlayerTemplate = noIsPC;
    PartyManager.Player = undefined;
    await areaLoadPlayer();
    expect(PartyManager.Player.npcId).toBe(-1);
    expect(PartyManager.IsProtagonist(PartyManager.Player)).toBe(true);
  });

  test('ExportPlayerCharacter writes the protagonist to pc.utc, not a reloaded companion ModulePlayer', async () => {
    const exile = PartyManager.ActualPlayerTemplate = creatureTemplate('exile', 1);
    const companionAsPlayer = new ModulePlayer(creatureTemplate('atton', 0));
    companionAsPlayer.load();
    companionAsPlayer.npcId = 2;
    PartyManager.Player = companionAsPlayer;
    (CurrentGame as any).gameinprogress_dir = 'gip';
    const written: string[] = [];
    (GFFObject.prototype.export as jest.Mock).mockImplementation(function(this: GFFObject){
      written.push(this.RootNode.getFieldByLabel('Tag').getValue());
      return Promise.resolve(this);
    });
    await PartyManager.ExportPlayerCharacter();
    expect(written).toEqual(['exile']);
    expect(PartyManager.ActualPlayerTemplate).toBe(exile);
  });

  test('GetPUPOwner(NPC_PLAYER) is the protagonist, not a reloaded companion ModulePlayer', () => {
    PartyManager.ResetPartyTableState();
    const companionAsPlayer = new ModulePlayer(creatureTemplate('atton', 0));
    companionAsPlayer.npcId = 2;
    const exile = new ModulePlayer(creatureTemplate('exile', 1));
    exile.load();
    exile.npcId = -1;
    const remote = new ModuleCreature(creatureTemplate('remote', 0));
    PartyManager.AddAvailablePUPByObject(0, remote);
    PartyManager.AssignPUP(0, -1);
    PartyManager.AddPartyPuppet(0, remote);
    PartyManager.party = [companionAsPlayer];
    expect(PartyManager.GetPuppetOwner(remote)).toBeUndefined();
    PartyManager.party = [companionAsPlayer, exile];
    expect(PartyManager.GetPuppetOwner(remote)).toBe(exile);
  });
});
