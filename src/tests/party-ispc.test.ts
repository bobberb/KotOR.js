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
    expect(PartyManager.CurrentMembers).toEqual([{ isLeader: false, memberID: 5 }]);

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
    const destroy = jest.spyOn(atton, 'destroy').mockImplementation(() => {});
    PartyManager.party = [atton];
    PartyManager.Save();
    expect(PartyManager.CurrentMembers).toEqual([]);

    const { MenuPartySelection } = loadSourceWithStubs('game/kotor/menu/MenuPartySelection.ts', { '@/GameState': { GameState } });
    const menu = Object.create(MenuPartySelection.prototype);
    menu.isNPCRequired = () => false;
    menu.isSelectable = () => true;
    // The screen must not offer to add the companion already in control...
    expect(menu.canAdd(2)).toBe(false);
    expect(menu.canAdd(5)).toBe(true);
    // ...and the manager must refuse it too.
    await PartyManager.AddNPCById(2);
    expect(PartyManager.CurrentMembers).toEqual([]);

    // A save written before Save() excluded the Player can still list it.
    PartyManager.CurrentMembers.push({ isLeader: false, memberID: 2 });
    expect(menu.canRemove(2)).toBe(false);
    expect(menu.getCurrentMemberCount()).toBe(0);
    PartyManager.RemoveNPCById(2, false);
    expect(PartyManager.party).toEqual([atton]);
    expect(destroy).not.toHaveBeenCalled();
  });

  test('switching into a companion already in the party takes over that creature, no duplicate', () => {
    PartyManager.ResetPartyTableState();
    PartyManager.NPCS[2] = { template: creatureTemplate('atton', 0), available: true, canSelect: true, spawned: false };
    PartyManager.NPCS[5] = { template: creatureTemplate('bao', 0), available: true, canSelect: true, spawned: false };
    const exile = PartyManager.Player;
    jest.spyOn(exile, 'destroy').mockImplementation(() => {});
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
    expect(exile.destroy).toHaveBeenCalled();
    expect(PartyManager.CurrentMembers.map((m) => m.memberID)).toEqual([5]);
    expect(PartyManager.ActualPlayerTemplate.RootNode.getFieldByLabel('Tag').getValue()).toBe('exile');

    // companion -> companion: the previous one steps into the member's slot
    expect(PartyManager.SwitchPlayerCharacter(5)).toBe(baoPM);
    expect(roster()).toEqual(['bao:5(P)', 'atton:2']);
    expect(PartyManager.CurrentMembers.map((m) => m.memberID)).toEqual([2]);
    expect(PartyManager.GetControlledNPC()).toBe(5);
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
