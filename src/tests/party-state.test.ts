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
import { ActionParameterType } from '@/enums/actions/ActionParameterType';
import { buildRuntimeAction, EngineVariant } from '@/nwscript/builtins/actionBuilder';
import * as partyRoutines from '@/nwscript/builtins/party';
import { SetSoloMode, GetSoloMode } from '@/nwscript/builtins/objects/party';
import { ActionFollowLeader } from '@/actions/ActionFollowLeader';

const state = GameState as any;
const CREATURE = ModuleObjectType.ModuleObject | ModuleObjectType.ModuleCreature;

function routine(def: any, engine: EngineVariant = 'tsl', caller?: any) {
  const built = buildRuntimeAction(def, engine)!;
  expect(built).toBeDefined();
  return (...args: any[]) => built.action!.call({ caller }, args);
}

let nextId = 100;
/** A creature as far as PartyManager/BitWise care: object type bits, transform, area, tag. */
function creature(props: { npcId?: number, tag?: string, x?: number, y?: number, facing?: number } = {}): any {
  const c: any = Object.create(ModuleCreature.prototype);
  Object.assign(c, {
    id: nextId++,
    objectType: CREATURE,
    destroyed: false,
    npcId: props.npcId,
    position: new THREE.Vector3(props.x ?? 0, props.y ?? 0, 0),
    rotation: new THREE.Euler(0, 0, props.facing ?? 0),
    area: { id: 7, isPointWalkable: () => true, getNearestWalkablePoint: (p: THREE.Vector3) => p },
    actionQueue: { add: jest.fn(), addFront: jest.fn() },
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
  state.Planetary = { SaveStruct: () => new GFFStruct(), LoadStruct: jest.fn() };
  state.TwoDAManager = { datatables: new Map() };
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

  test('a corrupt out-of-range PT_NPC_INFLUENCE loads clamped', async () => {
    PartyManager.InfluenceMap.set(1, 250);
    PartyManager.InfluenceMap.set(2, -9);
    await saveAndReload();
    expect(get()(1)).toBe(100);
    expect(get()(2)).toBe(0);
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

    // The area save brings the creature back; scripts on it must still see a puppet with an owner.
    const reloadedOwner = creature({ npcId: 4 });
    PartyManager.party = [creature({ npcId: -1 }), reloadedOwner];
    const reloadedRemote = creature({ tag: 'G_REMOTE' });
    expect(routine(partyRoutines.GetIsPuppet)(reloadedRemote)).toBe(1);
    expect(routine(partyRoutines.GetPUPOwner)(reloadedRemote)).toBe(reloadedOwner);
    expect(routine(partyRoutines.GetIsPuppet)(creature({ tag: 'bao_dur_remote' }))).toBe(0); // available, not in party
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

  test('a save without the optional scalars loads defaults, not the previous session\'s values', async () => {
    PartyManager.XPPool = 9; PartyManager.aiStyle = 2; PartyManager.FollowState = 1; PartyManager.ControlledNPC = 3;
    PartyManager.SwoopUpgrade1 = 4; PartyManager.InfluenceMap.set(0, 99); PartyManager.ChemicalCount = 5;
    const gff = new GFFObject();
    gff.RootNode.addField(new GFFField(GFFDataType.DWORD, 'PT_GOLD')).setValue(0);
    await PartyManager.Load(gff);
    expect([PartyManager.XPPool, PartyManager.aiStyle, PartyManager.FollowState, PartyManager.ControlledNPC,
      PartyManager.SwoopUpgrade1, PartyManager.InfluenceMap.get(0), PartyManager.ChemicalCount])
      .toEqual([0, 0, 0, -1, -1, PartyManager.INFLUENCE_DEFAULT, 0]);
  });

  test('PT_CONTROLLED_NP is the leading companion\'s NPC id, -1 when the protagonist leads', async () => {
    const protagonist = Object.assign(Object.create(ModulePlayer.prototype), creature({ npcId: -1 }));
    const companion = creature({ npcId: 6 });
    PartyManager.Player = protagonist;
    PartyManager.party = [companion, protagonist];
    expect((await exportPartyTable()).RootNode.getFieldByLabel('PT_CONTROLLED_NP').getValue()).toBe(6);
    PartyManager.party = [protagonist, companion];
    expect((await exportPartyTable()).RootNode.getFieldByLabel('PT_CONTROLLED_NP').getValue()).toBe(-1);
  });
});
