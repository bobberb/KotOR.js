import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

/**
 * Party state that PARTYTABLE persists, driven through the real PartyManager.Load/Export,
 * the real nwscript routine definitions, and the real ActionFollowLeader.
 *
 * Export writes through GFFObject.export; the spy below captures the exact bytes it would
 * write, and Load reads them back as a fresh GFFObject, so every assertion crosses the
 * binary GFF boundary rather than comparing in-memory structs.
 */

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/loaders', () => ({ ResourceLoader: { loadCachedResource: jest.fn() }, MDLLoader: { loader: { load: async (): Promise<undefined> => undefined } } }));
jest.mock('@/loaders/MDLLoader', () => ({ MDLLoader: { loader: { load: async (): Promise<undefined> => undefined } } }));
jest.mock('@/module/ModuleCreature', () => ({ ModuleCreature: class {} }));
jest.mock('@/module/ModulePlayer', () => {
  const { ModuleCreature } = jest.requireMock('@/module/ModuleCreature') as any;
  return { ModulePlayer: class extends ModuleCreature {} };
});
jest.mock('@/three/odyssey', () => ({ OdysseyModel3D: class {} }));
jest.mock('@/engine/CurrentGame', () => ({ CurrentGame: { gameinprogress_dir: 'gip' } }));
jest.mock('@/utility/GameFileSystem', () => ({ GameFileSystem: { readFile: jest.fn(async () => new Uint8Array()) } }));

import * as THREE from 'three';
import { GameState } from '@/GameState';
import { PartyManager, PartyFormationPattern } from '@/managers/PartyManager';
import { ModuleCreature } from '@/module/ModuleCreature';
import { ModulePlayer } from '@/module/ModulePlayer';
import { GameFileSystem } from '@/utility/GameFileSystem';
import { GFFObject } from '@/resource/GFFObject';
import { GFFField } from '@/resource/GFFField';
import { GFFStruct } from '@/resource/GFFStruct';
import { GFFDataType } from '@/enums/resource/GFFDataType';
import { GameEngineType } from '@/enums/engine/GameEngineType';
import { ModuleObjectType } from '@/enums/module/ModuleObjectType';
import { ActionStatus } from '@/enums/actions/ActionStatus';
import { ActionType } from '@/enums/actions/ActionType';
import { ModuleCreatureAnimState } from '@/enums/module/ModuleCreatureAnimState';
import { KeyMapAction } from '@/enums/controls/KeyMapAction';
import { ActionParameterType } from '@/enums/actions/ActionParameterType';
import { buildRuntimeAction, EngineVariant } from '@/nwscript/builtins/actionBuilder';
import * as partyRoutines from '@/nwscript/builtins/party';
import { SetSoloMode, GetSoloMode } from '@/nwscript/builtins/objects/party';
import { ActionFollowLeader } from '@/actions/ActionFollowLeader';
import { loadSourceWithStubs } from './support/loadSourceWithStubs';

const state = GameState as any;
const CREATURE = ModuleObjectType.ModuleObject | ModuleObjectType.ModuleCreature;

function routine(def: any, engine: EngineVariant = 'tsl', caller?: any) {
  const built = buildRuntimeAction(def, engine)!;
  expect(built).toBeDefined();
  return (...args: any[]) => built.action!.call({ caller }, args);
}

let nextId = 100;
/** A creature as far as PartyManager/BitWise care: object type bits, transform, area, tag. */
function creature(props: { npcId?: number, tag?: string, x?: number, y?: number, facing?: number, isPC?: number } = {}): any {
  const c: any = Object.create(ModuleCreature.prototype);
  Object.assign(c, {
    id: nextId++,
    objectType: CREATURE,
    destroyed: false,
    npcId: props.npcId,
    // npcId -1 stands for the protagonist in these tests, which always carries IsPC.
    isPC: props.isPC ?? (props.npcId === -1 ? 1 : 0),
    position: new THREE.Vector3(props.x ?? 0, props.y ?? 0, 0),
    rotation: new THREE.Euler(0, 0, props.facing ?? 0),
    area: { id: 7, isPointWalkable: () => true, getNearestWalkablePoint: (p: THREE.Vector3) => p },
    actionQueue: Object.assign([] as any[], { add: jest.fn(), addFront: jest.fn() }),
    setAnimationState: jest.fn(),
    setComputedPath: jest.fn(),
    getHitDistance: () => 1,
    getTag: () => props.tag ?? '',
    save: () => utc(props.tag ?? ''),
  });
  return c;
}

function utc(tag: string){
  const gff = new GFFObject();
  gff.RootNode.addField(new GFFField(GFFDataType.CEXOSTRING, 'Tag')).setValue(tag);
  return gff;
}

function loadModuleAreaClass(): any {
  return loadSourceWithStubs('module/ModuleArea.ts', {
    '@/GameState': { GameState },
    '@/module/ModuleCreature': { ModuleCreature },
  }).ModuleArea;
}

let exported: Uint8Array | undefined;
async function exportPartyTable(): Promise<GFFObject> {
  exported = undefined;
  await PartyManager.Export('save');
  expect(exported).toBeDefined();
  return new GFFObject(exported);
}

/** Export, wipe every piece of party state, then Load what was written. */
async function saveAndReload(): Promise<GFFObject> {
  const gff = await exportPartyTable();
  PartyManager.ResetPartyTableState();
  state.SOLOMODE = false;
  await PartyManager.Load(gff);
  return gff;
}

function useGame(key: GameEngineType){
  state.GameKey = key;
  PartyManager.Initialize();
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(GFFObject.prototype, 'export').mockImplementation(function(this: GFFObject, _file: string, onExport?: Function){
    exported = this.getExportBuffer();
    onExport?.();
    return Promise.resolve(this);
  });
  (GameFileSystem.readFile as any).mockImplementation(async () => new Uint8Array());

  state.PartyManager = PartyManager;
  state.Planetary = { SaveStruct: () => new GFFStruct(), LoadStruct: jest.fn(), Reset: jest.fn() };
  state.InventoryManager = { ClearInventory: jest.fn() };
  state.TwoDAManager = { datatables: new Map() };
  state.TutorialWindowTracker = [];
  const messages = () => ({ Entries: [] as any[], ClearEntries: jest.fn(), AddEntry: jest.fn(), SortOrder: 0 });
  state.JournalManager = messages();
  state.DialogMessageManager = messages();
  state.FeedbackMessageManager = messages();
  const cards = new Map();
  for(let i = 0; i < 19; i++){ cards.set(i, { card: i, count: 0 }); }
  state.PazaakManager = { Cards: cards, PlayerSideDeck: new Map(), Initialize: jest.fn() };
  state.time = 0;
  state.getCurrentPlayer = () => PartyManager.party[0] ?? PartyManager.Player;
  state.Mode = 0;
  state.module = { area: { id: 7 } };
  state.ActionFactory = {
    ActionMoveToPoint: class { params: any[] = []; setParameter(i: number, _t: number, v: any){ this.params[i] = v; } },
    ActionForceFollowObject: class { params: any[] = []; setParameter(i: number, _t: number, v: any){ this.params[i] = v; } },
  };

  PartyManager.party = [];
  PartyManager.CurrentMembers = [];
  PartyManager.Player = undefined;
  PartyManager.Gold = 0;
  useGame(GameEngineType.TSL);
});

afterEach(() => {
  jest.restoreAllMocks();
  state.SOLOMODE = false;
});

describe('TSL influence (routines 795-797)', () => {
  const get = () => routine(partyRoutines.GetInfluence);
  const set = () => routine(partyRoutines.SetInfluence);
  const modify = () => routine(partyRoutines.ModifyInfluence);

  test('SetInfluence/ModifyInfluence/GetInfluence are real implementations in TSL', () => {
    for(const def of [partyRoutines.SetInfluence, partyRoutines.ModifyInfluence, partyRoutines.GetInfluence]){
      expect(typeof buildRuntimeAction(def, 'tsl')!.action).toBe('function');
    }
  });

  test('SetInfluence sets 0-100 and ignores out-of-range values and non-CNPC slots', () => {
    set()(3, 80);
    expect(get()(3)).toBe(80);
    set()(3, 101);
    set()(3, -1);
    expect(get()(3)).toBe(80);
    set()(3, 0);
    expect(get()(3)).toBe(0);
    set()(3, 100);
    expect(get()(3)).toBe(100);
    set()(12, 40);
    set()(-1, 40);
    expect(PartyManager.InfluenceMap.has(12)).toBe(false);
  });

  test('ModifyInfluence adds and clamps at both ends', () => {
    set()(2, 95);
    modify()(2, 10);
    expect(get()(2)).toBe(100);
    modify()(2, -30);
    expect(get()(2)).toBe(70);
    modify()(2, -500);
    expect(get()(2)).toBe(0);
  });

  test('GetInfluence is 0 for a non-CNPC and the neutral default for an untouched CNPC', () => {
    expect(get()(-1)).toBe(0);
    expect(get()(12)).toBe(0);
    expect(get()(5)).toBe(PartyManager.INFLUENCE_DEFAULT);
  });

  test('influence survives Export -> binary PARTYTABLE -> Load, and GetInfluence reads it back', async () => {
    set()(0, 12);
    set()(4, 88);
    modify()(11, -50);
    const gff = await saveAndReload();
    const list = gff.RootNode.getFieldByLabel('PT_INFLUENCE').getChildStructs();
    expect(list.length).toBe(12);
    expect(list[4].getFieldByLabel('PT_NPC_INFLUENCE').getValue()).toBe(88);
    expect(get()(0)).toBe(12);
    expect(get()(4)).toBe(88);
    expect(get()(11)).toBe(0);
    expect(get()(7)).toBe(PartyManager.INFLUENCE_DEFAULT);
  });

  test('an out-of-range PT_NPC_INFLUENCE loads as the neutral default, not a clamped extreme', async () => {
    PartyManager.InfluenceMap.set(1, 250);
    PartyManager.InfluenceMap.set(2, -9);
    PartyManager.InfluenceMap.set(3, 100);
    PartyManager.InfluenceMap.set(4, 0);
    await saveAndReload();
    expect(get()(1)).toBe(PartyManager.INFLUENCE_DEFAULT);
    expect(get()(2)).toBe(PartyManager.INFLUENCE_DEFAULT);
    expect(get()(3)).toBe(100);
    expect(get()(4)).toBe(0);
  });

  test('an older kotor.js/Forge TSL save with PT_NPC_INFLUENCE -1 in every slot loads neutral', async () => {
    const gff = new GFFObject();
    gff.RootNode.addField(new GFFField(GFFDataType.DWORD, 'PT_GOLD')).setValue(0);
    const list = gff.RootNode.addField(new GFFField(GFFDataType.LIST, 'PT_INFLUENCE'));
    for(let i = 0; i < 12; i++){
      const s = new GFFStruct();
      s.addField(new GFFField(GFFDataType.INT, 'PT_NPC_INFLUENCE')).setValue(-1);
      list.addChildStruct(s);
    }
    await PartyManager.Load(new GFFObject(gff.getExportBuffer()));
    for(let i = 0; i < 12; i++){ expect(get()(i)).toBe(PartyManager.INFLUENCE_DEFAULT); }
  });

  test('PT_INFLUENCE entries past the last CNPC slot are ignored', async () => {
    const gff = new GFFObject();
    gff.RootNode.addField(new GFFField(GFFDataType.DWORD, 'PT_GOLD')).setValue(0);
    const list = gff.RootNode.addField(new GFFField(GFFDataType.LIST, 'PT_INFLUENCE'));
    for(let i = 0; i < 14; i++){
      const s = new GFFStruct();
      s.addField(new GFFField(GFFDataType.INT, 'PT_NPC_INFLUENCE')).setValue(70);
      list.addChildStruct(s);
    }
    await PartyManager.Load(gff);
    expect(get()(11)).toBe(70);
    expect(PartyManager.InfluenceMap.has(12)).toBe(false);
    expect(PartyManager.InfluenceMap.has(13)).toBe(false);
  });
});

describe('TSL puppets (routines 836-843)', () => {
  test('add, assign, join, owner lookup and GetIsPuppet', () => {
    const owner = creature({ npcId: 4, tag: 'kreia' });
    PartyManager.party = [creature({ npcId: -1 }), owner];
    const remote = creature({ tag: 'remote' });
    const stranger = creature({ tag: 'stranger' });

    expect(routine(partyRoutines.AddPartyPuppet)(0, remote)).toBe(0); // not available yet
    expect(routine(partyRoutines.AddAvailablePUPByObject)(0, remote)).toBe(1);
    expect(routine(partyRoutines.AssignPUP)(0, 4)).toBe(1);
    expect(routine(partyRoutines.AssignPUP)(0, 12)).toBe(0);
    expect(routine(partyRoutines.AssignPUP)(3, 4)).toBe(0);
    expect(routine(partyRoutines.AddPartyPuppet)(0, remote)).toBe(1);

    expect(routine(partyRoutines.GetIsPuppet)(remote)).toBe(1);
    expect(routine(partyRoutines.GetIsPuppet)(stranger)).toBe(0);
    expect(routine(partyRoutines.GetPUPOwner)(remote)).toBe(owner);
    expect(routine(partyRoutines.GetPUPOwner)(stranger)).toBeUndefined();
    expect(PartyManager.PuppetMembers).toEqual([0]);
  });

  test('NPC_PLAYER owns a puppet: GetPUPOwner returns the protagonist', () => {
    const protagonist = Object.assign(Object.create(ModulePlayer.prototype), creature({ npcId: -1 }));
    PartyManager.party = [protagonist];
    PartyManager.Player = protagonist;
    const remote = creature({ tag: 'remote' });
    routine(partyRoutines.AddAvailablePUPByObject)(1, remote);
    routine(partyRoutines.AssignPUP)(1, -1);
    routine(partyRoutines.AddPartyPuppet)(1, remote);
    expect(routine(partyRoutines.GetPUPOwner)(remote)).toBe(protagonist);
  });

  test('ActionFollowOwner queues a follow of the owner at fRange, and nothing for a non-puppet', () => {
    const owner = creature({ npcId: 2 });
    PartyManager.party = [creature({ npcId: -1 }), owner];
    const remote = creature({ tag: 'remote' });
    routine(partyRoutines.AddAvailablePUPByObject)(0, remote);
    routine(partyRoutines.AssignPUP)(0, 2);
    routine(partyRoutines.AddPartyPuppet)(0, remote);

    routine(partyRoutines.ActionFollowOwner, 'tsl', remote)(4.0);
    expect(remote.actionQueue.add).toHaveBeenCalledTimes(1);
    const action = (remote.actionQueue.add as jest.Mock).mock.calls[0][0] as any;
    expect(action).toBeInstanceOf(state.ActionFactory.ActionForceFollowObject);
    expect(action.params).toEqual([owner.id, 4.0]);

    const stranger = creature();
    routine(partyRoutines.ActionFollowOwner, 'tsl', stranger)();
    expect(stranger.actionQueue.add).not.toHaveBeenCalled();
  });

  test('availability, owner and party membership round-trip; the reloaded creature relinks by tag', async () => {
    const owner = creature({ npcId: 4 });
    const remote = creature({ tag: 'g_remote' });
    PartyManager.party = [creature({ npcId: -1 }), owner];
    routine(partyRoutines.AddAvailablePUPByObject)(0, remote);
    routine(partyRoutines.AssignPUP)(0, 4);
    routine(partyRoutines.AddPartyPuppet)(0, remote);
    routine(partyRoutines.AddAvailablePUPByTemplate)(2, utc('bao_dur_remote'));
    PartyManager.Puppets[2].select = false;
    const remoteTemplate = PartyManager.Puppets[0].template!.getExportBuffer();
    PartyManager.party = [];

    (GameFileSystem.readFile as any).mockImplementation(async (file: string) =>
      /availpup0\.utc$/i.test(file) ? remoteTemplate : new Uint8Array());
    const gff = await saveAndReload();

    const ids = gff.RootNode.getFieldByLabel('PT_PUPPETS').getChildStructs().map(s => s.getFieldByLabel('PT_PUPPET_ID').getValue());
    expect(ids).toEqual([0]);
    expect(PartyManager.PuppetMembers).toEqual([0]);
    expect(PartyManager.Puppets[0]).toMatchObject({ available: true, owner: 4 });
    expect(PartyManager.Puppets[0].moduleObject).toBeUndefined();
    expect(PartyManager.Puppets[1]).toMatchObject({ available: false, owner: undefined });
    expect(PartyManager.Puppets[2]).toMatchObject({ available: true, select: false });

    // The area save brings the creature back; the area's party load relinks it, then scripts see a puppet with an owner.
    const reloadedOwner = creature({ npcId: 4 });
    PartyManager.party = [creature({ npcId: -1 }), reloadedOwner];
    const reloadedRemote = creature({ tag: 'G_REMOTE' });
    const baoRemote = creature({ tag: 'bao_dur_remote' });
    expect(routine(partyRoutines.GetIsPuppet)(reloadedRemote)).toBe(0); // not linked until the area load says so
    PartyManager.RelinkPuppets([creature({ tag: 'trandoshan' }), reloadedRemote, baoRemote]);
    expect(routine(partyRoutines.GetIsPuppet)(reloadedRemote)).toBe(1);
    expect(routine(partyRoutines.GetPUPOwner)(reloadedRemote)).toBe(reloadedOwner);
    expect(routine(partyRoutines.GetIsPuppet)(baoRemote)).toBe(0); // available, not in party
  });

  test('ExportPartyMemberTemplates refreshes a live puppet from its creature, never from a destroyed one', async () => {
    (GFFObject.prototype.export as jest.Mock).mockImplementation(function(this: GFFObject){ return Promise.resolve(this); });
    jest.spyOn(PartyManager, 'ExportPlayerCharacter').mockResolvedValue(undefined);
    const live = joinedRemote();
    live.save = jest.fn(() => utc('g_remote_levelled'));
    await PartyManager.ExportPartyMemberTemplates();
    expect(PartyManager.Puppets[0].template!.RootNode.getFieldByLabel('Tag').getValue()).toBe('g_remote_levelled');

    live.destroyed = true;
    live.save = jest.fn(() => utc('torn_down'));
    await PartyManager.ExportPartyMemberTemplates();
    expect(live.save).not.toHaveBeenCalled();
    expect(PartyManager.Puppets[0].template!.RootNode.getFieldByLabel('Tag').getValue()).toBe('g_remote_levelled');
  });

  function joinedRemote(tag = 'g_remote'){
    const remote = creature({ tag });
    routine(partyRoutines.AddAvailablePUPByObject)(0, remote);
    routine(partyRoutines.AddPartyPuppet)(0, remote);
    return remote;
  }

  test('queries never relink: asking about a same-tag decoy does not steal the slot', () => {
    const remote = joinedRemote();
    remote.destroyed = true;
    const decoy = creature({ tag: 'g_remote' });
    expect(routine(partyRoutines.GetIsPuppet)(decoy)).toBe(0);
    expect(routine(partyRoutines.GetPUPOwner)(decoy)).toBeUndefined();
    expect(PartyManager.Puppets[0].moduleObject).toBe(remote);
  });

  test('a destroyed puppet creature (module transition) relinks to its same-tag replacement', () => {
    const remote = joinedRemote();
    remote.destroyed = true;
    const next = creature({ tag: 'g_remote' });
    PartyManager.RelinkPuppets([next]);
    expect(routine(partyRoutines.GetIsPuppet)(next)).toBe(1);
  });

  test('a puppet creature that is in no area counts as unlinked', () => {
    const remote = joinedRemote();
    remote.area = undefined;
    const next = creature({ tag: 'g_remote' });
    PartyManager.RelinkPuppets([next]);
    expect(PartyManager.Puppets[0].moduleObject).toBe(next);
  });

  test('a live, linked puppet is not replaced by another creature with its tag', () => {
    const remote = joinedRemote();
    const twin = creature({ tag: 'g_remote' });
    PartyManager.RelinkPuppets([twin]);
    expect(PartyManager.Puppets[0].moduleObject).toBe(remote);
    expect(routine(partyRoutines.GetIsPuppet)(twin)).toBe(0);
  });

  test('ModuleArea.loadParty relinks puppets from the area creatures', async () => {
    const ModuleArea = loadModuleAreaClass();
    const remote = joinedRemote();
    remote.destroyed = true;
    const restored = creature({ tag: 'g_remote' });
    PartyManager.party = [creature({ npcId: -1 })];
    jest.spyOn(PartyManager, 'RebuildPortraitOrder').mockImplementation(() => {});
    await ModuleArea.prototype.loadParty.call({ creatures: [creature({ tag: 'rodian' }), restored] });
    expect(PartyManager.Puppets[0].moduleObject).toBe(restored);
  });

  test('SpawnAvailablePUP spawns only an available puppet, and links a party puppet to the spawn', () => {
    const attached: any[] = [];
    state.Module = { ModuleArea: { ModuleCreature: class {
      objectType = CREATURE; area = { id: 7 }; template: any;
      constructor(t: any){ this.template = t; }
      load(){} clearAllActions(){} loadModel(){ return new Promise(() => {}); }
      getTag(){ return 'g_remote'; }
    } } };
    const location: any = { area: { attachObject: (o: any) => attached.push(o) }, position: new THREE.Vector3(), getFacing: () => 0 };
    const spawn = routine(partyRoutines.SpawnAvailablePUP);

    PartyManager.Puppets[0].template = utc('g_remote'); // a template, but never made available
    expect(spawn(0, location)).toBeUndefined();
    expect(attached).toEqual([]);

    const old = joinedRemote();
    old.destroyed = true;
    const spawned = spawn(0, location);
    expect(spawned).toBeDefined();
    expect(spawned.template.RootNode.getFieldByLabel('Tag').getValue()).toBe('g_remote'); // a fresh copy of the slot template
    expect(attached).toEqual([spawned]);
    expect(PartyManager.Puppets[0].moduleObject).toBe(spawned);
  });

  test('SavePUPByObject stores the puppet template', () => {
    const { SavePUPByObject } = require('@/nwscript/builtins/missing');
    routine(SavePUPByObject)(2, creature({ tag: 'hk_pup' }));
    expect(PartyManager.Puppets[2].available).toBe(true);
    expect(PartyManager.Puppets[2].template.RootNode.getFieldByLabel('Tag').getValue()).toBe('hk_pup');
  });

  test('AddPartyPuppet refuses a creature already bound to another puppet slot', () => {
    const remote = joinedRemote();
    routine(partyRoutines.AddAvailablePUPByObject)(1, creature({ tag: 'other' }));
    expect(routine(partyRoutines.AddPartyPuppet)(1, remote)).toBe(0);
    expect(PartyManager.PuppetMembers).toEqual([0]);
  });

  test('NPC_PLAYER owner is the protagonist in the party, never the companion in control', () => {
    const remote = joinedRemote();
    routine(partyRoutines.AssignPUP)(0, -1);
    const atton = creature({ npcId: 0 });
    PartyManager.Player = atton; // SwitchPlayerCharacter puppet segment
    PartyManager.party = [atton];
    expect(routine(partyRoutines.GetPUPOwner)(remote)).toBeUndefined();
    const protagonist = Object.assign(Object.create(ModulePlayer.prototype), creature({ npcId: -1 }));
    PartyManager.party = [atton, protagonist];
    expect(routine(partyRoutines.GetPUPOwner)(remote)).toBe(protagonist);
  });

  test('ActionFollowOwner does nothing when the puppet is its own owner', () => {
    const self = creature({ npcId: 2, tag: 'g_remote' });
    PartyManager.party = [creature({ npcId: -1 }), self];
    routine(partyRoutines.AddAvailablePUPByObject)(0, self);
    routine(partyRoutines.AssignPUP)(0, 2);
    routine(partyRoutines.AddPartyPuppet)(0, self);
    routine(partyRoutines.ActionFollowOwner, 'tsl', self)();
    expect(self.actionQueue.add).not.toHaveBeenCalled();
  });

  test('PT_PUPPETS with a differently labelled element still loads the puppet id', async () => {
    const gff = new GFFObject();
    gff.RootNode.addField(new GFFField(GFFDataType.DWORD, 'PT_GOLD')).setValue(0);
    const list = gff.RootNode.addField(new GFFField(GFFDataType.LIST, 'PT_PUPPETS'));
    const s = new GFFStruct();
    s.addField(new GFFField(GFFDataType.DWORD, 'PT_PUP_ID')).setValue(2);
    list.addChildStruct(s);
    await PartyManager.Load(new GFFObject(gff.getExportBuffer()));
    expect(PartyManager.PuppetMembers).toEqual([2]);
  });

  test('a PT_AVAIL_PUPS list longer than the puppet table loads without throwing', async () => {
    const gff = new GFFObject();
    gff.RootNode.addField(new GFFField(GFFDataType.DWORD, 'PT_GOLD')).setValue(0);
    const list = gff.RootNode.addField(new GFFField(GFFDataType.LIST, 'PT_AVAIL_PUPS'));
    for(let i = 0; i < 5; i++){
      const s = new GFFStruct();
      s.addField(new GFFField(GFFDataType.BYTE, 'PT_PUP_AVAIL')).setValue(1);
      s.addField(new GFFField(GFFDataType.BYTE, 'PT_PUP_SELECT')).setValue(1);
      list.addChildStruct(s);
    }
    await PartyManager.Load(gff);
    expect([0, 1, 2].map(i => PartyManager.Puppets[i].available)).toEqual([true, true, true]);
    expect(PartyManager.Puppets[3]).toBeUndefined();
  });

  test('ExportPartyMemberTemplates writes each puppet template', async () => {
    const remote = creature({ tag: 'g_remote' });
    routine(partyRoutines.AddAvailablePUPByObject)(1, remote);
    const written: string[] = [];
    (GFFObject.prototype.export as jest.Mock).mockImplementation(function(this: GFFObject, file: string){
      written.push(file);
      return Promise.resolve(this);
    });
    jest.spyOn(PartyManager, 'ExportPlayerCharacter').mockResolvedValue(undefined);
    await PartyManager.ExportPartyMemberTemplates();
    expect(written.filter(f => /AVAILPUP/i.test(f))).toEqual([expect.stringMatching(/AVAILPUP1\.utc$/)]);
  });
});

describe('solo mode', () => {
  function follower(){
    const leader = creature({ npcId: -1, x: 0, y: 0 });
    const member = creature({ npcId: 1, x: 20, y: 0 });
    PartyManager.party = [leader, member];
    const action = new ActionFollowLeader();
    action.owner = member;
    return { leader, member, action };
  }

  test('followers path to the leader out of solo mode', () => {
    const { member, action } = follower();
    expect(action.update(0)).toBe(ActionStatus.IN_PROGRESS);
    expect(member.actionQueue.addFront).toHaveBeenCalledTimes(1);
  });

  test('SetSoloMode(TRUE) makes followers stay put', () => {
    const { member, action } = follower();
    routine(SetSoloMode, 'kotor')(1);
    expect(routine(GetSoloMode, 'kotor')()).toBe(1);
    expect(action.update(0)).toBe(ActionStatus.COMPLETE);
    expect(member.actionQueue.addFront).not.toHaveBeenCalled();
  });

  test('turning solo mode on cancels a follow move already under way, for non-leaders only', () => {
    const { leader, member } = follower();
    const act = (type: number, groupId: number) => ({ type, groupId, dispose: jest.fn() });
    const followMove = act(ActionType.ActionMoveToPoint, 5);
    const follow = act(ActionType.ActionFollowLeader, 5);
    const scriptedMove = act(ActionType.ActionMoveToPoint, 9);
    member.actionQueue.push(followMove, follow, scriptedMove);
    const leaderFollow = act(ActionType.ActionFollowLeader, 3);
    leader.actionQueue.push(leaderFollow);

    routine(SetSoloMode, 'kotor')(0);
    expect(member.actionQueue.length).toBe(3);

    routine(SetSoloMode, 'kotor')(1);
    expect([...member.actionQueue]).toEqual([scriptedMove]);
    expect(followMove.dispose).toHaveBeenCalled();
    expect(member.setComputedPath).toHaveBeenCalledWith(undefined);
    expect(member.speed).toBe(0);
    expect(member.setAnimationState).toHaveBeenCalledWith(ModuleCreatureAnimState.IDLE);
    expect(leader.setAnimationState).not.toHaveBeenCalled();
    expect([...leader.actionQueue]).toEqual([leaderFollow]);
  });

  /** Anything-goes stand-in for GUI controls; records the listeners a menu wires. */
  function guiStub(listeners: Map<string, Function>, name = '', keymaps?: Map<string, string>): any {
    const self: any = new Proxy(function(){}, {
      get(_t, key){
        if(key === 'then') return undefined;
        if(key === Symbol.toPrimitive || key === 'valueOf') return () => 0;
        if(key === 'toString') return () => '';
        if(key === 'addEventListener') return (_type: string, fn: Function) => { listeners.set(name, fn); return self; };
        if(key === 'setKeymapAction' && keymaps) return (action: string) => { keymaps.set(name, action); return self; };
        return self;
      },
      apply(){ return self; },
      set(){ return true; },
    });
    return self;
  }

  async function wireOverlay(game: 'kotor' | 'tsl', keymaps = new Map<string, string>()){
    const listeners = new Map<string, Function>();
    // Real GameState (PartyManager, SOLOMODE) where the test set it; inert stubs for the HUD's other subsystems.
    const hudGameState = new Proxy(state, { get: (t, key) => key in t ? t[key] : guiStub(new Map()) });
    const imports: Record<string, any> = {
      '@/GameState': { GameState: hudGameState },
      'three': THREE,
      '@/gui': { GameMenu: class { async menuControlInitializer(){} }, LBL_MapView: function(){ return guiStub(new Map()); } },
      '@/loaders': { TextureLoader: { Load: async (): Promise<undefined> => undefined } },
      '@/loaders/TextureLoader': { TextureLoader: { Load: async (): Promise<undefined> => undefined } },
      '@/enums': { KeyMapAction, ModuleObjectType },
      '@/enums/controls/KeyMapAction': { KeyMapAction },
    };
    const K1 = loadSourceWithStubs('game/kotor/menu/InGameOverlay.ts', imports).InGameOverlay;
    const Overlay = game == 'kotor' ? K1 : loadSourceWithStubs('game/tsl/menu/InGameOverlay.ts', { ...imports, '@/game/kotor/KOTOR': { InGameOverlay: K1 } }).InGameOverlay;
    const target = Object.create(Overlay.prototype);
    const controls = new Map<string, any>();
    const menu = new Proxy(target, {
      get(t, key){
        if(key in t || typeof key !== 'string') return t[key as any];
        if(!controls.has(key)) controls.set(key, guiStub(listeners, key, keymaps));
        return controls.get(key);
      },
      set(t, key, value){ t[key as any] = value; return true; },
    });
    state.TLKManager = { TLKStrings: guiStub(new Map()) };
    // The tail of the initializer builds renderer objects; the button wiring under test happens before it.
    const done = Overlay.prototype.menuControlInitializer.call(menu).catch((): undefined => undefined);
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 50))]);
    return listeners;
  }

  test.each(['kotor', 'tsl'] as const)('the %s HUD solo button toggles solo mode through SetSoloMode, cancelling follows', async (game) => {
    const { member } = follower();
    const follow = { type: ActionType.ActionFollowLeader, groupId: 4, dispose: jest.fn() };
    member.actionQueue.push(follow);
    const click = (await wireOverlay(game)).get('TB_SOLO')!;
    expect(click).toBeDefined();

    click({ stopPropagation(){} });
    expect(state.SOLOMODE).toBe(true);
    expect([...member.actionQueue]).toEqual([]);
    click({ stopPropagation(){} });
    expect(state.SOLOMODE).toBe(false);
  });

  test.each(['kotor', 'tsl'] as const)('the %s HUD solo button is bound to the party-active key', async (game) => {
    follower();
    const keymaps = new Map<string, string>();
    await wireOverlay(game, keymaps);
    expect(keymaps.get('TB_SOLO')).toBe(KeyMapAction.PartyActive);
  });

  test('a stuck companion is warped to its slot, but not in solo mode or when it is the one in control', () => {
    const { leader, member } = follower();
    member.collisionTimer = 1;
    expect(PartyManager.ShouldWarpStuckMember(member)).toBe(true);
    state.SOLOMODE = true;
    expect(PartyManager.ShouldWarpStuckMember(member)).toBe(false);
    state.SOLOMODE = false;
    member.collisionTimer = 0.5;
    expect(PartyManager.ShouldWarpStuckMember(member)).toBe(false);
    leader.collisionTimer = 2;
    expect(PartyManager.ShouldWarpStuckMember(leader)).toBe(false);
    const stranger = creature();
    stranger.collisionTimer = 2;
    expect(PartyManager.ShouldWarpStuckMember(stranger)).toBe(false);
  });

  test('ModuleCreature routes its stuck-member warp through ShouldWarpStuckMember', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../module/ModuleCreature.ts'), 'utf8');
    expect(source).toMatch(/if \(GameState\.PartyManager\.ShouldWarpStuckMember\(this\)\) \{\s*this\.setPosition\(GameState\.PartyManager\.GetFollowPosition\(this\)\);/);
  });

  test('PT_SOLOMODE round-trips both ways', async () => {
    routine(SetSoloMode, 'kotor')(1);
    let gff = await saveAndReload();
    expect(gff.RootNode.getFieldByLabel('PT_SOLOMODE').getValue()).toBe(1);
    expect(state.SOLOMODE).toBe(true);

    routine(SetSoloMode, 'kotor')(0);
    gff = await saveAndReload();
    expect(gff.RootNode.getFieldByLabel('PT_SOLOMODE').getValue()).toBe(0);
    expect(state.SOLOMODE).toBe(false);
  });

  test('loading a save without PT_SOLOMODE clears a stale solo mode', async () => {
    const gff = new GFFObject();
    gff.RootNode.addField(new GFFField(GFFDataType.DWORD, 'PT_GOLD')).setValue(0);
    state.SOLOMODE = true;
    await PartyManager.Load(gff);
    expect(state.SOLOMODE).toBe(false);
  });
});

describe('SetFormation (729)', () => {
  const near = (v: THREE.Vector3, x: number, y: number) => {
    expect(v.x).toBeCloseTo(x, 6);
    expect(v.y).toBeCloseTo(y, 6);
  };

  test('is implemented for both games', () => {
    expect(typeof buildRuntimeAction(partyRoutines.SetFormation, 'kotor')!.action).toBe('function');
    expect(typeof buildRuntimeAction(partyRoutines.SetFormation, 'tsl')!.action).toBe('function');
  });

  test('default follow slots are unchanged: slot 1 on the leader\'s left, slot 2 on the right', () => {
    // facing 0 looks down +Y, so the right hand is +X
    const leader = creature({ npcId: -1, x: 10, y: 10, facing: 0 });
    const a = creature({ npcId: 1 });
    const b = creature({ npcId: 2 });
    PartyManager.party = [leader, a, b];
    near(PartyManager.GetFollowPosition(a).clone(), 8.5, 10);
    near(PartyManager.GetFollowPosition(b).clone(), 11.5, 10);
  });

  test('WEDGE puts a follower behind and to the side of the anchor, rotated with its facing', () => {
    const leader = creature({ npcId: -1, x: 10, y: 10, facing: 0 });
    const a = creature({ npcId: 1 });
    PartyManager.party = [leader, a];
    routine(partyRoutines.SetFormation, 'kotor')(leader, a, PartyFormationPattern.WEDGE, 3);
    near(PartyManager.GetFollowPosition(a).clone(), 10 - 3, 10 - 3);

    leader.rotation.z = Math.PI / 2; // now facing -X; right hand is +Y
    near(PartyManager.GetFollowPosition(a).clone(), 10 + 3, 10 - 3);
  });

  test('LINE position 4 is two ranks out on the right', () => {
    const leader = creature({ npcId: -1, x: 0, y: 0, facing: 0 });
    const a = creature({ npcId: 1 });
    PartyManager.party = [leader, a];
    routine(partyRoutines.SetFormation, 'kotor')(leader, a, PartyFormationPattern.LINE, 4);
    near(PartyManager.GetFollowPosition(a).clone(), 3, 0);
  });

  test('the follow action steers to the formation slot', () => {
    const leader = creature({ npcId: -1, x: 0, y: 0, facing: 0 });
    const a = creature({ npcId: 1, x: 40, y: 40 });
    PartyManager.party = [leader, a];
    routine(partyRoutines.SetFormation, 'kotor')(leader, a, PartyFormationPattern.WEDGE, 1);
    const action = new ActionFollowLeader();
    action.owner = a;
    action.update(0);
    const move = (a.actionQueue.addFront as jest.Mock).mock.calls[0][0] as any;
    expect(move.params[0]).toBeCloseTo(-1.5, 6);
    expect(move.params[1]).toBeCloseTo(-1.5, 6);
  });

  test('invalid pattern, position, or self-anchoring is ignored', () => {
    const leader = creature({ npcId: -1, x: 0, y: 0, facing: 0 });
    const a = creature({ npcId: 1 });
    PartyManager.party = [leader, a];
    const set = routine(partyRoutines.SetFormation, 'kotor');
    set(leader, a, 7, 1);
    set(leader, a, PartyFormationPattern.LINE, 0);
    set(leader, a, PartyFormationPattern.LINE, 11);
    set(a, a, PartyFormationPattern.LINE, 2);
    near(PartyManager.GetFollowPosition(a).clone(), -1.5, 0);
  });

  test('a destroyed anchor falls back to the default party slot', () => {
    const leader = creature({ npcId: -1, x: 0, y: 0, facing: 0 });
    const guard = creature({ npcId: -1, x: 50, y: 50, facing: 0 });
    const a = creature({ npcId: 1 });
    PartyManager.party = [leader, a];
    routine(partyRoutines.SetFormation, 'kotor')(guard, a, PartyFormationPattern.LINE, 2);
    near(PartyManager.GetFollowPosition(a).clone(), 51.5, 50);
    guard.destroyed = true;
    near(PartyManager.GetFollowPosition(a).clone(), -1.5, 0);
  });

  test('a formation slot off the walkmesh snaps to the nearest walkable point', () => {
    const leader = creature({ npcId: -1, x: 0, y: 0, facing: 0 });
    const a = creature({ npcId: 1 });
    a.area = { isPointWalkable: () => false, getNearestWalkablePoint: () => new THREE.Vector3(9, 9, 0) };
    PartyManager.party = [leader, a];
    routine(partyRoutines.SetFormation, 'kotor')(leader, a, PartyFormationPattern.WEDGE, 1);
    near(PartyManager.GetFollowPosition(a).clone(), 9, 9);
  });
});

describe('PARTYTABLE scalars round-trip through Export/Load', () => {
  const tslScalars: Array<[string, () => void, () => any, any]> = [
    ['PT_XP_POOL', () => { PartyManager.XPPool = 4321; }, () => PartyManager.XPPool, 4321],
    ['PT_AISTATE', () => { PartyManager.aiStyle = 2; }, () => PartyManager.aiStyle, 2],
    ['PT_FOLLOWSTATE', () => { PartyManager.FollowState = 1; }, () => PartyManager.FollowState, 1],
    ['PT_CHEAT_USED', () => { PartyManager.CheatUsed = 1; }, () => PartyManager.CheatUsed, 1],
    ['PT_LAST_GUI_PNL', () => { PartyManager.LastGUIPanel = 3; }, () => PartyManager.LastGUIPanel, 3],
    ['PT_CONTROLLED_NP', () => { PartyManager.ControlledNPC = 5; }, () => PartyManager.ControlledNPC, 5],
    ['PT_SOLOMODE', () => { state.SOLOMODE = true; }, () => state.SOLOMODE, true],
    ['PT_GOLD', () => { PartyManager.Gold = 777; }, () => PartyManager.Gold, 777],
    ['PT_ITEM_CHEMICAL', () => { PartyManager.ChemicalCount = 31; }, () => PartyManager.ChemicalCount, 31],
    ['PT_ITEM_COMPONEN', () => { PartyManager.ComponentCount = 42; }, () => PartyManager.ComponentCount, 42],
    ['PT_SWOOP1', () => { PartyManager.SwoopUpgrade1 = 3; }, () => PartyManager.SwoopUpgrade1, 3],
    ['PT_SWOOP2', () => { PartyManager.SwoopUpgrade2 = 5; }, () => PartyManager.SwoopUpgrade2, 5],
    ['PT_SWOOP3', () => { PartyManager.SwoopUpgrade3 = 8; }, () => PartyManager.SwoopUpgrade3, 8],
    ['PT_DISABLEREGEN', () => { state.disableHealthRegen = true; }, () => state.disableHealthRegen, true],
  ];

  test.each(tslScalars)('TSL %s', async (label, set, read, expected) => {
    set();
    const gff = await saveAndReload();
    expect(gff.RootNode.hasField(label)).toBe(true);
    expect(read()).toEqual(expected);
  });

  const k1Scalars = tslScalars.filter(([label]) => !/SWOOP|DISABLEREGEN|ITEM_/.test(label));
  test.each(k1Scalars)('K1 %s', async (label, set, read, expected) => {
    useGame(GameEngineType.KOTOR);
    set();
    const gff = await saveAndReload();
    expect(gff.RootNode.hasField(label)).toBe(true);
    expect(read()).toEqual(expected);
  });

  test('K1 writes no TSL-only party fields', async () => {
    useGame(GameEngineType.KOTOR);
    const gff = await exportPartyTable();
    for(const label of ['PT_INFLUENCE', 'PT_AVAIL_PUPS', 'PT_PUPPETS', 'PT_SWOOP1', 'PT_DISABLEREGEN', 'PT_ITEM_CHEMICAL']){
      expect(gff.RootNode.hasField(label)).toBe(false);
    }
  });

  /** Dirty every piece of state PARTYTABLE owns, as a previous session would leave it. */
  function dirtyPartyTableState(){
    PartyManager.XPPool = 9; PartyManager.aiStyle = 2; PartyManager.FollowState = 1; PartyManager.ControlledNPC = 3;
    PartyManager.CheatUsed = 1; PartyManager.LastGUIPanel = 4;
    PartyManager.SwoopUpgrade1 = 4; PartyManager.SwoopUpgrade2 = 5; PartyManager.SwoopUpgrade3 = 6;
    PartyManager.InfluenceMap.set(0, 99); PartyManager.ChemicalCount = 5; PartyManager.ComponentCount = 6;
    state.SOLOMODE = true; state.disableHealthRegen = true;
    PartyManager.NPCS[3].available = true;
    PartyManager.Puppets[0].available = true; PartyManager.Puppets[0].owner = 4;
    PartyManager.PuppetMembers = [0];
    const anchor = creature({ npcId: -1 }), member = creature({ npcId: 1 });
    PartyManager.SetFormation(anchor, member, PartyFormationPattern.WEDGE, 2);
    return member;
  }

  function expectPartyTableDefaults(formationMember: any){
    expect({
      XPPool: PartyManager.XPPool, aiStyle: PartyManager.aiStyle, FollowState: PartyManager.FollowState,
      ControlledNPC: PartyManager.ControlledNPC, CheatUsed: PartyManager.CheatUsed, LastGUIPanel: PartyManager.LastGUIPanel,
      swoop: [PartyManager.SwoopUpgrade1, PartyManager.SwoopUpgrade2, PartyManager.SwoopUpgrade3],
      influence0: PartyManager.InfluenceMap.get(0), chemical: PartyManager.ChemicalCount, component: PartyManager.ComponentCount,
      solo: state.SOLOMODE, noRegen: state.disableHealthRegen, npc3: PartyManager.NPCS[3].available,
      pup0: { available: PartyManager.Puppets[0].available, owner: PartyManager.Puppets[0].owner },
      puppetMembers: PartyManager.PuppetMembers, formation: PartyManager.Formations.has(formationMember),
    }).toEqual({
      XPPool: 0, aiStyle: 0, FollowState: 0, ControlledNPC: -1, CheatUsed: 0, LastGUIPanel: 0,
      swoop: [-1, -1, -1], influence0: PartyManager.INFLUENCE_DEFAULT, chemical: 0, component: 0,
      solo: false, noRegen: false, npc3: false, pup0: { available: false, owner: undefined },
      puppetMembers: [], formation: false,
    });
  }

  test('a save without the optional scalars loads defaults, not the previous session\'s values', async () => {
    const member = dirtyPartyTableState();
    const gff = new GFFObject();
    gff.RootNode.addField(new GFFField(GFFDataType.DWORD, 'PT_GOLD')).setValue(0);
    await PartyManager.Load(gff);
    expectPartyTableDefaults(member);
  });

  test('ResetForNewGame clears the party table plus the roster, portraits and gold', () => {
    const member = dirtyPartyTableState();
    PartyManager.CurrentMembers = [{ isLeader: false, memberID: 3 }];
    PartyManager.party = [creature({ npcId: 3 })];
    PartyManager.PortraitOrder = ['po_patton'];
    PartyManager.Gold = 500;
    PartyManager.ResetForNewGame();
    expectPartyTableDefaults(member);
    expect([PartyManager.CurrentMembers, PartyManager.party, PartyManager.PortraitOrder, PartyManager.Gold]).toEqual([[], [], [], 0]);
  });

  test('GetControlledNPC is -1 for a player creature with no NPC slot, whatever was loaded', () => {
    PartyManager.ControlledNPC = 5;
    PartyManager.Player = creature({ npcId: undefined });
    expect(PartyManager.GetControlledNPC()).toBe(-1);
    PartyManager.Player = creature({ npcId: -1 });
    expect(PartyManager.GetControlledNPC()).toBe(-1);
  });

  test('IsProtagonist needs IsPC and no NPC slot: a slotless party creature is not the PC', () => {
    expect(PartyManager.IsProtagonist(creature({ npcId: -1 }))).toBe(true);
    expect(PartyManager.IsProtagonist(creature({ npcId: undefined, isPC: 1 }))).toBe(true);
    expect(PartyManager.IsProtagonist(creature({ npcId: undefined }))).toBe(false);
    expect(PartyManager.IsProtagonist(creature({ npcId: 3, isPC: 1 }))).toBe(false); // old companion templates carry IsPC=1
  });

  test('PartyManager.Save records the companion in control for the module transition that follows', () => {
    PartyManager.ControlledNPC = -1;
    PartyManager.Player = creature({ npcId: 4 });
    PartyManager.party = [];
    jest.spyOn(PartyManager, 'SyncPlayerStateTemplates').mockImplementation(() => {});
    PartyManager.Save();
    expect(PartyManager.ControlledNPC).toBe(4);
    PartyManager.Player = creature({ npcId: -1 });
    PartyManager.Save();
    expect(PartyManager.ControlledNPC).toBe(-1);
  });
});

describe('AddPartyMember (574)', () => {
  beforeEach(() => {
    state.module = { area: { id: 7, creatures: [] as any[] } };
    jest.spyOn(PartyManager, 'SavePartyMember').mockResolvedValue(undefined);
  });

  test('binds the creature to its NPC slot, so it is a companion, not the protagonist, and persists in PT_MEMBERS', async () => {
    const protagonist = creature({ npcId: -1, tag: 'revan' });
    const hk = creature({ tag: 'hk47', isPC: 1 }); // a world template that (wrongly) carries IsPC
    hk.clearAllActions = jest.fn();
    hk.template = utc('hk47');
    state.module.area.creatures.push(hk);
    PartyManager.Player = protagonist;
    PartyManager.party = [protagonist];

    const add = routine(partyRoutines.AddPartyMember, 'kotor');
    expect(add(5, hk)).toBe(1);
    expect(hk.npcId).toBe(5);
    expect(hk.isPC).toBe(0); // its saved template must not claim to be the protagonist (Module.setFromIFO trusts IsPC)
    expect(PartyManager.IsProtagonist(hk)).toBe(false);
    expect(PartyManager.IsNPCInParty(5)).toBe(true);
    expect(state.module.area.creatures).toEqual([]);
    expect(routine(partyRoutines.IsNPCPartyMember, 'kotor')(5)).toBe(1);

    PartyManager.Save();
    expect(PartyManager.CurrentMembers).toEqual([{ isLeader: false, memberID: 5 }]);
    const ids = (await exportPartyTable()).RootNode.getFieldByLabel('PT_MEMBERS').getChildStructs()
      .map(s => s.getFieldByLabel('PT_MEMBER_ID').getValue());
    expect(ids).toEqual([5]);
  });

  test('refuses an invalid NPC slot', () => {
    const add = routine(partyRoutines.AddPartyMember, 'kotor');
    const stray = creature({ tag: 'stray' });
    stray.clearAllActions = jest.fn();
    expect(add(12, stray)).toBe(0);
    expect(add(-1, stray)).toBe(0);
    expect(stray.npcId).toBeUndefined();
    expect(PartyManager.party).toEqual([]);
  });

  function recruit(tag: string){
    const c = creature({ tag });
    c.clearAllActions = jest.fn();
    c.template = utc(tag);
    return c;
  }

  test('adding the same creature to the same slot twice is a no-op', () => {
    const add = routine(partyRoutines.AddPartyMember, 'kotor');
    const mission = recruit('mission');
    const zaalbar = recruit('zaalbar');
    expect(add(2, mission)).toBe(1);
    expect(add(3, zaalbar)).toBe(1);
    PartyManager.CurrentMembers[0].isLeader = true;
    expect(add(2, mission)).toBe(1);
    expect(PartyManager.party.filter((p) => p === mission).length).toBe(1);
    // Untouched: same order, leader flag kept, its actions not cleared a second time.
    expect(PartyManager.CurrentMembers).toEqual([{ isLeader: true, memberID: 2 }, { isLeader: false, memberID: 3 }]);
    expect(mission.clearAllActions).toHaveBeenCalledTimes(1);
  });

  test('re-slotting a member moves it: one party entry, the old slot unbound', () => {
    const add = routine(partyRoutines.AddPartyMember, 'kotor');
    const mission = recruit('mission');
    add(2, mission);
    expect(add(5, mission)).toBe(1);
    expect(PartyManager.party.filter((p) => p === mission).length).toBe(1);
    expect(mission.npcId).toBe(5);
    expect(PartyManager.CurrentMembers.map((m) => m.memberID)).toEqual([5]);
    expect(PartyManager.NPCS[2].moduleObject).toBeUndefined();
    expect(PartyManager.NPCS[5].moduleObject).toBe(mission);
  });

  test('a slot held by a different party creature is refused', () => {
    const add = routine(partyRoutines.AddPartyMember, 'kotor');
    const mission = recruit('mission');
    const zaalbar = recruit('zaalbar');
    add(2, mission);
    expect(add(2, zaalbar)).toBe(0);
    expect(zaalbar.npcId).toBeUndefined();
    expect(PartyManager.party.filter((p) => p.npcId === 2)).toEqual([mission]);
  });

  test('a full party (leader + 2 companions) refuses a third companion', () => {
    const protagonist = creature({ npcId: -1, tag: 'revan' });
    PartyManager.Player = protagonist;
    PartyManager.party = [protagonist];
    const add = routine(partyRoutines.AddPartyMember, 'kotor');
    expect(add(1, recruit('a'))).toBe(1);
    expect(add(2, recruit('b'))).toBe(1);
    const c = recruit('c');
    expect(add(3, c)).toBe(0);
    expect(PartyManager.party.length).toBe(3);
    expect(PartyManager.CurrentMembers.length).toBe(2);
    expect(c.npcId).toBeUndefined();
  });

  test('the Player and the slot of the companion in control are refused', () => {
    const atton = creature({ npcId: 2, tag: 'atton' });
    PartyManager.Player = atton;
    PartyManager.party = [atton];
    const add = routine(partyRoutines.AddPartyMember, 'kotor');
    expect(add(4, atton)).toBe(0);
    expect(atton.npcId).toBe(2);
    expect(add(2, recruit('clone'))).toBe(0);
    // Even before the Player is placed in the party array (area load in progress).
    PartyManager.party = [];
    const clone = recruit('clone');
    expect(add(2, clone)).toBe(0);
    expect(clone.npcId).toBeUndefined();
  });

  test('PT_CONTROLLED_NP is the companion the player switched into; party leadership is PT_IS_LEADER\'s job', async () => {
    const protagonist = Object.assign(Object.create(ModulePlayer.prototype), creature({ npcId: -1 }));
    const companion = creature({ npcId: 6 });
    PartyManager.Player = protagonist;
    PartyManager.party = [companion, protagonist]; // companion leads, protagonist is still the player
    expect((await exportPartyTable()).RootNode.getFieldByLabel('PT_CONTROLLED_NP').getValue()).toBe(-1);
    PartyManager.Player = companion; // SwitchPlayerCharacter(6)
    PartyManager.party = [companion];
    expect((await exportPartyTable()).RootNode.getFieldByLabel('PT_CONTROLLED_NP').getValue()).toBe(6);
  });
});
