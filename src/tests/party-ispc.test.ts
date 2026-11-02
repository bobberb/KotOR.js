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
