import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

/**
 * Traps (mines) and locks follow the KotOR d20 skill rules.
 *
 * Executes the real ModuleCreature perception pass, ModuleTrigger entry/save/load,
 * the mine actions (disarm/recover/set), ModuleDoor/ModulePlaceable.attemptUnlock
 * and the trap/lock NWScript routines, against synthetic traps.2da rows and with
 * the d20 seeded through Dice.rollD20.
 *
 * Rule summary (SWTrapRules.ts): check = ranks + key-ability modifier + skill
 * effects + d20 >= DC. Out of combat the d20 is taken as 20, in combat it is
 * rolled. Disarm/recover failing by 5+ sets the mine off; recovering adds +5 DC.
 * Passive detection: party members only, 10 m, TrapDetectable only.
 */

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/utility/GameFileSystem', () => ({ GameFileSystem: {} }));
jest.mock('@/engine/CurrentGame', () => ({ CurrentGame: { WriteFile: jest.fn() } }));
jest.mock('@/loaders/ResourceLoader', () => ({ ResourceLoader: { loadCachedResource: jest.fn() } }));
jest.mock('@/loaders', () => ({
  MDLLoader: { loader: { load: () => new Promise(() => {}) } },
  ResourceLoader: { loadCachedResource: jest.fn() },
  TextureLoader: {},
}));
jest.mock('@/odyssey', () => ({
  OdysseyModel: class {}, OdysseyModelAnimation: class {}, OdysseyWalkMesh: class {},
}));
jest.mock('@/three/odyssey', () => {
  const THREE = jest.requireActual('three') as typeof import('three');
  return {
    OdysseyModel3D: class { quaternion = new THREE.Quaternion(); },
    OdysseyObject3D: class extends THREE.Object3D {},
    OdysseyLightsaberEffect: class {},
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

import * as THREE from 'three';
import { GameState } from '@/GameState';
import { ResourceLoader } from '@/loaders/ResourceLoader';
import { ResourceTypes } from '@/resource/ResourceTypes';
import { GFFObject } from '@/resource/GFFObject';
import { GFFField } from '@/resource/GFFField';
import { GFFStruct } from '@/resource/GFFStruct';
import { GFFDataType } from '@/enums/resource/GFFDataType';
import { ModuleObjectType } from '@/enums/module/ModuleObjectType';
import { ModuleTriggerType } from '@/enums/module/ModuleTriggerType';
import { ModuleObjectConstant } from '@/enums/module/ModuleObjectConstant';
import { SignalEventType } from '@/enums/events/SignalEventType';
import { ActionStatus } from '@/enums/actions/ActionStatus';
import { ActionParameterType } from '@/enums/actions/ActionParameterType';
import { ActionType } from '@/enums/actions/ActionType';
import { GameEffectType } from '@/enums/effects/GameEffectType';
import { SSFType } from '@/enums/resource/SSFType';
import { SkillType } from '@/enums/nwscript/SkillType';
import { ModuleItemProperty } from '@/enums/module/ModuleItemProperty';
import { Dice } from '@/utility/Dice';
import { ModuleCreature } from '@/module/ModuleCreature';
import { ModuleTrigger } from '@/module/ModuleTrigger';
import { ModuleDoor } from '@/module/ModuleDoor';
import { ModulePlaceable } from '@/module/ModulePlaceable';
import { ModuleItem } from '@/module/ModuleItem';
import { ModuleObject } from '@/module/ModuleObject';
import { ActionDisarmMine } from '@/actions/ActionDisarmMine';
import { ActionRecoverMine } from '@/actions/ActionRecoverMine';
import { ActionFlagMine } from '@/actions/ActionFlagMine';
import { ActionSetMine } from '@/actions/ActionSetMine';
import * as trapRoutines from '@/nwscript/builtins/traps';
import { ActionExamineMine } from '@/actions/ActionExamineMine';
import { ActionUnlockObject } from '@/actions/ActionUnlockObject';
import { ActionMenuManager } from '@/engine/menu/ActionMenuManager';
import { ActionMenuPanel } from '@/engine/menu/ActionMenuPanel';
import { ActionMenuItem } from '@/engine/menu/ActionMenuItem';
import { ModuleObjectScript } from '@/enums/module/ModuleObjectScript';
import { GameEngineType } from '@/enums/engine/GameEngineType';
import { NWScript } from '@/nwscript/NWScript';
import { MDLLoader } from '@/loaders';
import { OdysseyModel3D } from '@/three/odyssey';
import { SWSkillCheck, SWTrapRules } from '@/engine/rules/SWTrapRules';
import { SPENT_TRAP_REMOVE_DELAY } from '@/module/ModuleTrigger';
import * as doorRoutines from '@/nwscript/builtins/doorsplaceables';
import { harness } from './nwscript/routineHarness';

const state = GameState as any;
const routines = trapRoutines as any;
const loadCachedResource = ResourceLoader.loadCachedResource as unknown as jest.Mock<(...args: any[]) => any>;

const FACTION_HOSTILE = 1;
const FACTION_PARTY = 2;
const FACTION_NEUTRAL = 5;
/** The PC's faction in this engine (CharGenManager/PartyManager write FactionID 0); companions keep theirs. */
const FACTION_PC = 0;

const TRAP_FRAG = 0;
const TRAPS_2DA_ROWS: Record<number, any> = {
  [TRAP_FRAG]: {
    label: 'FragMineMinor', name: '1', trapscript: 'k_trp_frag', setdc: '15',
    detectdcmod: '5', disarmdcmod: '10', resref: 'g_i_trapkit001', model: '', explosionsound: 'exp_frag',
  },
};
/** A row with explicit detectdc/disarmdc base columns. */
const TRAP_GAS = 1;
TRAPS_2DA_ROWS[TRAP_GAS] = {
  label: 'GasMine', name: '2', trapscript: '', setdc: '12', detectdc: '18', disarmdc: '22',
  detectdcmod: '1', disarmdcmod: '2', resref: 'g_i_trapkit002', model: '', explosionsound: '',
};

let registry: Map<number, any>;
let nextId: number;
let area: any;
let events: any[];

function register<T extends { id: number }>(object: T): T {
  object.id = nextId++;
  registry.set(object.id, object);
  return object;
}

function factionOf(object: any): number {
  return object?.faction?.id ?? object?.factionId;
}

/** A creature with ranks/abilities; party members share FACTION_PARTY. */
function creature(opts: {
  tag?: string, party?: boolean, faction?: number, awareness?: number, demolitions?: number, security?: number,
  int?: number, wis?: number, at?: [number, number], inCombat?: boolean,
} = {}): ModuleCreature {
  const gff = new GFFObject();
  gff.RootNode.addField(new GFFField(GFFDataType.CEXOSTRING, 'Tag')).setValue(opts.tag || 'c');
  const c = register(new ModuleCreature(gff));
  c.skills = [] as any;
  for (let i = 0; i < SkillType.MAX_SKILLS; i++) (c.skills as any)[i] = { rank: 0 };
  (c.skills as any)[SkillType.AWARENESS].rank = opts.awareness ?? 0;
  (c.skills as any)[SkillType.DEMOLITIONS].rank = opts.demolitions ?? 0;
  (c.skills as any)[SkillType.SECURITY].rank = opts.security ?? 0;
  c.int = opts.int ?? 10;
  c.wis = opts.wis ?? 10;
  c.factionId = opts.faction ?? (opts.party ? FACTION_PARTY : FACTION_HOSTILE);
  c.faction = state.FactionManager.factions.get(c.factionId);
  c.isPM = !!opts.party;
  if (opts.party) state.PartyManager.party.push(c);
  c.position.set(opts.at?.[0] ?? 0, opts.at?.[1] ?? 0, 0);
  c.area = area;
  (c as any).combatData = { combatState: !!opts.inCombat };
  jest.spyOn(c, 'isDead').mockReturnValue(false);
  // Raycasting needs a walkmesh; creature-to-creature perception is not under test.
  jest.spyOn(c, 'hasLineOfSight').mockReturnValue(false);
  jest.spyOn(c, 'playSoundSet').mockImplementation(() => {});
  return c;
}

/** A GIT-style mine trigger, placed in the area. */
function trapTrigger(opts: {
  at?: [number, number], detectDC?: number, disarmDC?: number, detectable?: number, disarmable?: number,
  faction?: number, keyName?: string, oneShot?: number, flag?: number,
} = {}): ModuleTrigger {
  const gff = new GFFObject();
  const add = (type: GFFDataType, label: string, value: any) => gff.RootNode.addField(new GFFField(type, label)).setValue(value);
  add(GFFDataType.BYTE, 'Type', ModuleTriggerType.TRAP);
  add(GFFDataType.BYTE, 'TrapType', TRAP_FRAG);
  add(GFFDataType.BYTE, 'TrapFlag', opts.flag ?? 1);
  add(GFFDataType.BYTE, 'TrapDetectable', opts.detectable ?? 1);
  add(GFFDataType.BYTE, 'TrapDisarmable', opts.disarmable ?? 1);
  add(GFFDataType.BYTE, 'TrapOneShot', opts.oneShot ?? 1);
  add(GFFDataType.BYTE, 'TrapDetectDC', opts.detectDC ?? 20);
  add(GFFDataType.BYTE, 'TrapDisarmDC', opts.disarmDC ?? 20);
  add(GFFDataType.DWORD, 'Faction', opts.faction ?? FACTION_HOSTILE);
  add(GFFDataType.CEXOSTRING, 'KeyName', opts.keyName ?? '');
  add(GFFDataType.FLOAT, 'XPosition', opts.at?.[0] ?? 0);
  add(GFFDataType.FLOAT, 'YPosition', opts.at?.[1] ?? 0);
  add(GFFDataType.FLOAT, 'ZPosition', 0);
  const geometry = gff.RootNode.addField(new GFFField(GFFDataType.LIST, 'Geometry'));
  for (const [x, y] of [[-1, 1], [-1, -1], [1, -1], [1, 1]]) {
    const v = new GFFStruct();
    v.addField(new GFFField(GFFDataType.FLOAT, 'PointX')).setValue(x);
    v.addField(new GFFField(GFFDataType.FLOAT, 'PointY')).setValue(y);
    v.addField(new GFFField(GFFDataType.FLOAT, 'PointZ')).setValue(0);
    geometry.addChildStruct(v);
  }
  const t = register(new ModuleTrigger(gff));
  t.load();
  area.attachObject(t);
  return t;
}

function perceive(c: ModuleCreature){
  c.spawned = true;
  c.perceptionTimer = 3;
  c.updatePerceptionList(0);
}

function trapEvents(){
  return events.filter(e => e.eventType == SignalEventType.OnTrapTriggered);
}

function runAction(action: any, owner: ModuleObjectLike, maxTicks = 5): ActionStatus {
  action.setOwner(owner);
  let status: ActionStatus = ActionStatus.IN_PROGRESS;
  for (let i = 0; i < maxTicks && status == ActionStatus.IN_PROGRESS; i++) {
    status = action.update(0);
    // ActionSetMine queues its animation in front of itself; the animation is not under test.
    owner.actionQueue?.clear?.();
  }
  return status;
}
type ModuleObjectLike = any;

function d20(...rolls: number[]){
  const spy = jest.spyOn(Dice, 'rollD20');
  for (const r of rolls) spy.mockReturnValueOnce(r);
  return spy;
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(ModuleCreature.prototype, 'loadModel').mockReturnValue(new Promise(() => {}));
  loadCachedResource.mockReset();

  registry = new Map();
  nextId = 100;
  events = [];
  area = {
    id: 1, triggers: [] as ModuleTrigger[], creatures: [] as ModuleCreature[],
    attachObject(o: any){ o.area = this; if (BitWise_isTrigger(o) && this.triggers.indexOf(o) < 0) this.triggers.push(o); },
    detachObject(o: any){ const i = this.triggers.indexOf(o); if (i >= 0) this.triggers.splice(i, 1); o.area = undefined; },
  };

  const factions = new Map<number, any>();
  for (const id of [FACTION_PC, FACTION_HOSTILE, FACTION_PARTY, FACTION_NEUTRAL]) factions.set(id, { id });
  const hostile = (a: any, b: any) => {
    const fa = factionOf(a), fb = factionOf(b);
    const partySide = (f: number) => f == FACTION_PARTY || f == FACTION_PC;
    return (fa == FACTION_HOSTILE && partySide(fb)) || (partySide(fa) && fb == FACTION_HOSTILE);
  };

  state.SWRuleSet = { skills: [], ranges: [], portraits: [], feats: [], classes: [] };
  state.ModuleObjectManager = {
    AddObjectById: jest.fn(),
    GetNextPlayerId: jest.fn(() => 1),
    GetObjectById: (id: number) => registry.get(id),
  };
  state.FactionManager = { factions, AddCreatureToFaction: jest.fn(), IsHostile: hostile };
  state.AppearanceManager = {
    GetCreatureAppearanceById: (): undefined => undefined,
    GetDoorAppearanceById: (): undefined => undefined,
    GetPlaceableAppearanceById: (): undefined => undefined,
  };
  state.ActionFactory = {
    FromStruct: jest.fn(() => undefined),
    ActionFlagMine,
    ActionPlayAnimation: class { setParameter(){} dispose(){} },
  };
  state.TwoDAManager = { datatables: new Map([['traps', { rows: TRAPS_2DA_ROWS }]]) };
  state.TLKManager = { GetStringById: () => ({ Value: 'Frag Mine' }) };
  state.NWScript = { Load: jest.fn(() => undefined) };
  state.GetDebugState = () => false;
  state.group = { triggers: new THREE.Group() };
  state.PartyManager = { party: [] as ModuleCreature[], GiveXP: jest.fn() };
  state.InventoryManager = { addItem: jest.fn(), removeItem: jest.fn(), getItemByTag: jest.fn(() => undefined) };
  state.GameEventFactory = {
    EventSignalEvent: class {
      eventType = -1; caller: any; object: any;
      setCaller(c: any){ this.caller = c; } setObject(o: any){ this.object = o; }
      setDay(){} setTime(){}
    },
  };
  state.module = {
    area, readyToProcessEvents: true,
    timeManager: { pauseDay: 0, pauseTime: 0, getFutureTimeFromSeconds: () => ({ pauseDay: 0, pauseTime: 0 }) },
    addEvent: (e: any) => events.push(e),
  };
  state.Module = { ModuleArea: { ModuleTrigger, ModuleItem, ModuleObject, ModuleDoor, ModulePlaceable, ModuleCreature } };
});

afterEach(() => jest.restoreAllMocks());

function BitWise_isTrigger(o: any){
  return ((o?.objectType ?? 0) & ModuleObjectType.ModuleTrigger) == ModuleObjectType.ModuleTrigger;
}

function queuedFlagMines(c: ModuleCreature){
  const queue: any[] = Array.from(c.actionQueue as any);
  return queue.filter(a => a?.type == ActionType.ActionFlagMine).length;
}

function mineItem(){
  return register({
    id: 0,
    objectType: ModuleObjectType.ModuleObject | ModuleObjectType.ModuleItem,
    charges: 1,
    properties: [{ subType: TRAP_FRAG, is: (type: number) => type == ModuleItemProperty.Trap }],
    getStackSize: () => 1,
    setStackSize(){},
    clone(){ return { ...this }; },
  } as any);
}

function layAt(pc: ModuleCreature, x: number, y: number){
  const item = mineItem();
  const action = new ActionSetMine();
  action.setParameter(0, ActionParameterType.DWORD, item.id);
  action.setParameter(1, ActionParameterType.DWORD, ModuleObjectConstant.OBJECT_INVALID);
  action.setParameter(2, ActionParameterType.FLOAT, x);
  action.setParameter(3, ActionParameterType.FLOAT, y);
  action.setParameter(4, ActionParameterType.FLOAT, 0);
  const before = area.triggers.length;
  const status = runAction(action, pc);
  const mine = (area.triggers.length > before ? area.triggers[area.triggers.length - 1] : undefined) as ModuleTrigger;
  // Make the new mine resolvable by id, as ModuleObjectManager would.
  if(mine) register(mine);
  return { status, item, mine };
}

function lockedDoor(openLockDC: number, keyRequired = 0){
  const gff = new GFFObject();
  gff.RootNode.addField(new GFFField(GFFDataType.BYTE, 'Locked')).setValue(1);
  gff.RootNode.addField(new GFFField(GFFDataType.BYTE, 'OpenLockDC')).setValue(openLockDC);
  gff.RootNode.addField(new GFFField(GFFDataType.BYTE, 'KeyRequired')).setValue(keyRequired);
  gff.RootNode.addField(new GFFField(GFFDataType.CEXOSTRING, 'KeyName')).setValue(keyRequired ? 'door_key' : '');
  const door = register(new ModuleDoor(gff));
  door.initProperties();
  door.locked = true;
  jest.spyOn(door, 'use').mockImplementation(() => {});
  return door;
}

function lockedPlaceable(openLockDC: number, keyRequired = 0){
  const plc = register(new ModulePlaceable(new GFFObject()));
  plc.locked = true;
  plc.openLockDC = openLockDC;
  plc.keyRequired = !!keyRequired;
  plc.keyName = keyRequired ? 'door_key' : '';
  jest.spyOn(plc, 'use').mockImplementation(() => {});
  return plc;
}

describe('passive mine detection (Awareness + d20 vs TrapDetectDC)', () => {
  test('a party member in range detects when Awareness + 20 meets the DC out of combat', () => {
    // 4 ranks + WIS 14 (+2) + take-20 = 26
    const pc = creature({ party: true, awareness: 4, wis: 14 });
    const trap = trapTrigger({ at: [5, 0], detectDC: 26 });
    perceive(pc);
    expect(trap.trapDetected).toBe(true);
    expect(routines.GetTrapDetectedBy.kotor.call({ caller: pc }, trap, pc)).toBe(1);
    expect(routines.GetLastTrapDetected.kotor.call({ caller: pc }, pc)).toBe(trap);
  });

  test('a DC one above the best total is not detected', () => {
    const pc = creature({ party: true, awareness: 4, wis: 14 });
    const trap = trapTrigger({ at: [5, 0], detectDC: 27 });
    perceive(pc);
    expect(trap.trapDetected).toBe(false);
    expect(queuedFlagMines(pc)).toBe(0);
  });

  test('a mine beyond the detection range is not detected however skilled', () => {
    const pc = creature({ party: true, awareness: 40 });
    const near = trapTrigger({ at: [9.5, 0], detectDC: 10 });
    const far = trapTrigger({ at: [10.5, 0], detectDC: 10 });
    perceive(pc);
    expect(near.trapDetected).toBe(true);
    expect(far.trapDetected).toBe(false);
    expect(queuedFlagMines(pc)).toBe(0);
  });

  test('an undetectable mine is never detected', () => {
    const pc = creature({ party: true, awareness: 40 });
    const trap = trapTrigger({ at: [1, 0], detectDC: 1, detectable: 0 });
    perceive(pc);
    expect(trap.trapDetected).toBe(false);
    expect(queuedFlagMines(pc)).toBe(0);
  });

  test('in combat the d20 is rolled', () => {
    const pc = creature({ party: true, awareness: 4, wis: 14, inCombat: true });
    const trap = trapTrigger({ at: [2, 0], detectDC: 15 });
    d20(8, 9);
    perceive(pc); // 6 + 8 = 14 < 15
    expect(trap.trapDetected).toBe(false);
    perceive(pc); // 6 + 9 = 15
    expect(trap.trapDetected).toBe(true);
  });

  test('NPCs do not detect mines and get nothing queued', () => {
    const npc = creature({ party: false, awareness: 40 });
    const trap = trapTrigger({ at: [1, 0], detectDC: 1 });
    perceive(npc);
    expect(trap.trapDetected).toBe(false);
    expect(trap.isTrapDetectedBy(npc)).toBe(false);
    expect(queuedFlagMines(npc)).toBe(0);
    expect(npc.actionQueue.length).toBe(0);
  });

  test('detection is shared by the faction, not by everyone', () => {
    const pc = creature({ party: true, awareness: 20 });
    const companion = creature({ party: true });
    const enemy = creature({ party: false, faction: FACTION_HOSTILE });
    const trap = trapTrigger({ at: [1, 0], detectDC: 10 });
    perceive(pc);
    expect(routines.GetTrapDetectedBy.kotor.call({}, trap, companion)).toBe(1);
    expect(routines.GetTrapDetectedBy.kotor.call({}, trap, enemy)).toBe(0);
  });
});

describe('disarm (Demolitions + d20 vs TrapDisarmDC)', () => {
  function disarm(pc: ModuleCreature, trap: ModuleTrigger){
    const action = new ActionDisarmMine();
    action.setParameter(0, ActionParameterType.DWORD, trap);
    const status = runAction(action, pc);
    return { status, action };
  }

  test('success removes the mine and grants XP', () => {
    // 5 ranks + INT 12 (+1) + take-20 = 26
    const pc = creature({ party: true, demolitions: 5, int: 12 });
    const trap = trapTrigger({ at: [1, 0], disarmDC: 26 });
    const { status } = disarm(pc, trap);
    expect(status).toBe(ActionStatus.COMPLETE);
    expect(trap.destroyed).toBe(true);
    expect(area.triggers).not.toContain(trap);
    expect(state.PartyManager.GiveXP).toHaveBeenCalledWith(26);
    expect(trapEvents()).toHaveLength(0);
  });

  test('a total below the DC fails and leaves the mine armed', () => {
    const pc = creature({ party: true, demolitions: 5, int: 12 });
    const trap = trapTrigger({ at: [1, 0], disarmDC: 27 });
    const { status } = disarm(pc, trap);
    expect(status).toBe(ActionStatus.FAILED);
    expect(trap.destroyed).toBeFalsy();
    expect(area.triggers).toContain(trap);
    expect(state.PartyManager.GiveXP).not.toHaveBeenCalled();
    expect(trapEvents()).toHaveLength(0);
  });

  test('failing by 4 is a plain failure; failing by 5 sets the mine off on the disarmer', () => {
    const pc = creature({ party: true, demolitions: 5, int: 12, inCombat: true });
    const trap = trapTrigger({ at: [1, 0], disarmDC: 18 });
    d20(8); // 6 + 8 = 14, short by 4
    expect(disarm(pc, trap).status).toBe(ActionStatus.FAILED);
    expect(trapEvents()).toHaveLength(0);
    expect(trap.destroyed).toBeFalsy();

    d20(7); // 6 + 7 = 13, short by 5
    expect(disarm(pc, trap).status).toBe(ActionStatus.FAILED);
    expect(trapEvents()).toHaveLength(1);
    expect(trapEvents()[0].caller).toBe(pc);
    expect(trapEvents()[0].object).toBe(trap);
  });

  test('a mine that is not disarmable cannot be disarmed', () => {
    const pc = creature({ party: true, demolitions: 40 });
    const trap = trapTrigger({ at: [1, 0], disarmDC: 1, disarmable: 0 });
    expect(disarm(pc, trap).status).toBe(ActionStatus.FAILED);
    expect(trap.destroyed).toBeFalsy();
  });

  test('carrying the trap key disarms it without a check', () => {
    const pc = creature({ party: true, demolitions: 0 });
    state.InventoryManager.getItemByTag = jest.fn((tag: string) => tag == 'mine_key' ? {} : undefined);
    const trap = trapTrigger({ at: [1, 0], disarmDC: 99, keyName: 'mine_key' });
    expect(disarm(pc, trap).status).toBe(ActionStatus.COMPLETE);
    expect(trap.destroyed).toBe(true);
  });
});

describe('recover (Demolitions vs disarm DC + 5) gives the mine item', () => {
  function recover(pc: ModuleCreature, trap: ModuleTrigger){
    const action = new ActionRecoverMine();
    action.setParameter(0, ActionParameterType.DWORD, trap);
    return runAction(action, pc);
  }

  function utiFor(tag: string){
    const uti = new GFFObject();
    uti.FileType = 'UTI ';
    uti.RootNode.addField(new GFFField(GFFDataType.CEXOSTRING, 'Tag')).setValue(tag);
    uti.RootNode.addField(new GFFField(GFFDataType.RESREF, 'TemplateResRef')).setValue(tag);
    return uti.getExportBuffer();
  }

  test('success loads the traps.2da resref as a .uti and adds it to the inventory', () => {
    loadCachedResource.mockImplementation((type: number, resref: string) =>
      type == ResourceTypes['uti'] && resref == 'g_i_trapkit001' ? utiFor('g_i_trapkit001') : undefined);
    jest.spyOn(ModuleItem.prototype, 'initProperties').mockImplementation(function(this: any){ this.tag = 'g_i_trapkit001'; });
    // 5 + 1 + 20 = 26 = disarm DC 21 + 5
    const pc = creature({ party: true, demolitions: 5, int: 12 });
    const trap = trapTrigger({ at: [1, 0], disarmDC: 21 });
    expect(recover(pc, trap)).toBe(ActionStatus.COMPLETE);
    expect(loadCachedResource).toHaveBeenCalledWith(ResourceTypes['uti'], 'g_i_trapkit001');
    expect(loadCachedResource).not.toHaveBeenCalledWith(ResourceTypes['utp'], expect.anything());
    expect(state.InventoryManager.addItem).toHaveBeenCalledTimes(1);
    const item = (state.InventoryManager.addItem as jest.Mock).mock.calls[0][0] as ModuleItem;
    expect(item).toBeInstanceOf(ModuleItem);
    expect(item.tag).toBe('g_i_trapkit001');
    expect(trap.destroyed).toBe(true);
  });

  test('a total that would disarm is not enough to recover', () => {
    loadCachedResource.mockReturnValue(undefined);
    const pc = creature({ party: true, demolitions: 5, int: 12 });
    const trap = trapTrigger({ at: [1, 0], disarmDC: 22 }); // needs 27
    expect(recover(pc, trap)).toBe(ActionStatus.FAILED);
    expect(trap.destroyed).toBeFalsy();
    expect(state.InventoryManager.addItem).not.toHaveBeenCalled();
  });

  test('failing a recovery by 5 sets the mine off', () => {
    const pc = creature({ party: true, demolitions: 5, int: 12, inCombat: true });
    const trap = trapTrigger({ at: [1, 0], disarmDC: 20 }); // needs 25
    d20(14); // 6 + 14 = 20, short by 5
    expect(recover(pc, trap)).toBe(ActionStatus.FAILED);
    expect(trapEvents()).toHaveLength(1);
  });
});

describe('laying a mine', () => {
  test('creates a party-owned mine trigger on the ground and uses up the item', () => {
    const pc = creature({ party: true, demolitions: 4, int: 12 });
    const { status, item, mine } = layAt(pc, 1, 1);
    expect(status).toBe(ActionStatus.COMPLETE);
    expect(mine).toBeInstanceOf(ModuleTrigger);
    expect(mine.type).toBe(ModuleTriggerType.TRAP);
    expect(mine.trapType).toBe(TRAP_FRAG);
    expect(mine.position.toArray()).toEqual([1, 1, 0]);
    expect(factionOf(mine)).toBe(FACTION_PARTY);
    // traps.2da setdc + *dcmod, independent of the layer's skill
    expect(mine.trapDetectDC).toBe(15 + 5);
    expect(mine.trapDisarmDC).toBe(15 + 10);
    expect(mine.trapDetected).toBe(true);
    expect(routines.GetTrapCreator.kotor.call({}, mine)).toBe(pc);
    expect(routines.GetIsTrapped.kotor.call({}, mine)).toBe(1);
    expect(state.NWScript.Load).toHaveBeenCalledWith('k_trp_frag');
    expect(state.InventoryManager.removeItem).toHaveBeenCalledWith(item, 1);
    // laying a mine on the ground does not blow it up 3s later (that is the door/placeable blast)
    expect(trapEvents()).toHaveLength(0);
  });

  test('the laid mine goes off for a hostile creature and not for the party or neutrals', () => {
    const pc = creature({ party: true, demolitions: 4 });
    const { mine } = layAt(pc, 0, 0);
    const companion = creature({ party: true, at: [0.5, 0.5] });
    const neutral = creature({ party: false, faction: FACTION_NEUTRAL, at: [0.5, 0.5] });
    mine.updateObjectInside(companion);
    mine.updateObjectInside(neutral);
    expect(trapEvents()).toHaveLength(0);

    const enemy = creature({ party: false, faction: FACTION_HOSTILE, at: [0.5, -0.5] });
    mine.updateObjectInside(enemy);
    expect(trapEvents()).toHaveLength(1);
    expect(trapEvents()[0].caller).toBe(enemy);

    const enemy2 = creature({ party: false, faction: FACTION_HOSTILE, at: [-0.5, -0.5] });
    mine.updateObjectInside(enemy2);
    expect(trapEvents()).toHaveLength(1); // one-shot
  });
});

describe('Security (Security + d20 vs OpenLockDC)', () => {
  test.each([
    ['door', lockedDoor],
    ['placeable', lockedPlaceable],
  ] as const)('%s: Security ranks + INT + 20 meeting the DC unlocks', (_, make) => {
    const pc = creature({ party: true, security: 3, int: 14 }); // 3 + 2 + 20 = 25
    const lock: any = make(25);
    expect(lock.attemptUnlock(pc)).toBe(true);
    expect(lock.isLocked()).toBe(false);
    expect(routines.GetLastUnlocked.kotor.call({ caller: lock })).toBe(pc);
  });

  test.each([
    ['door', lockedDoor],
    ['placeable', lockedPlaceable],
  ] as const)('%s: below the DC fails, stays locked and reports failure; WIS does not help', (_, make) => {
    const pc = creature({ party: true, security: 3, int: 14, wis: 30 }); // 25 vs 26
    const lock: any = make(26);
    expect(lock.attemptUnlock(pc)).toBe(false);
    expect(lock.isLocked()).toBe(true);
    expect(lock.use).not.toHaveBeenCalled();
  });

  test.each([
    ['door', lockedDoor],
    ['placeable', lockedPlaceable],
  ] as const)('%s: KeyRequired cannot be picked', (_, make) => {
    const pc = creature({ party: true, security: 40, int: 18 });
    const lock: any = make(1, 1);
    expect(lock.attemptUnlock(pc)).toBe(false);
    expect(lock.isLocked()).toBe(true);
  });

  test('Security cannot be used untrained', () => {
    const pc = creature({ party: true, security: 0, int: 30 });
    const door = lockedDoor(1);
    expect(door.attemptUnlock(pc)).toBe(false);
    expect(door.isLocked()).toBe(true);
  });

  test('a security tunneler (EffectSkillIncrease on Security) adds to the check', () => {
    const pc = creature({ party: true, security: 1 }); // 1 + 0 + 20 = 21
    const door = lockedDoor(24);
    expect(door.attemptUnlock(pc)).toBe(false);
    pc.effects.push({ type: GameEffectType.EffectSkillIncrease, getInt: (i: number) => [SkillType.SECURITY, 3][i] } as any);
    expect(door.attemptUnlock(pc)).toBe(true);
  });

  test('in combat the d20 is rolled', () => {
    const pc = creature({ party: true, security: 5, inCombat: true });
    const door = lockedDoor(15);
    d20(9, 10);
    expect(door.attemptUnlock(pc)).toBe(false); // 14
    expect(door.attemptUnlock(pc)).toBe(true); // 15
  });

  test('GetLastLocked reports who locked it', () => {
    const pc = creature({ party: true });
    const door = lockedDoor(10);
    door.locked = false;
    door.lock(pc);
    expect(routines.GetLastLocked.kotor.call({ caller: door })).toBe(pc);
    expect(routines.GetLastLocked.kotor.call({ caller: pc })).toBeUndefined();
  });
});

describe('trap routines', () => {
  test('GetTrapKeyTag returns the trigger trap key, SetTrapDetectedBy flags the faction', () => {
    const trap = trapTrigger({ keyName: 'tk_01' });
    const pc = creature({ party: true });
    const enemy = creature({ party: false, faction: FACTION_HOSTILE });
    expect(routines.GetTrapKeyTag.kotor.call({}, trap)).toBe('tk_01');
    expect(routines.GetTrapCreator.kotor.call({}, trap)).toBeUndefined();

    expect(routines.SetTrapDetectedBy.kotor.call({}, trap, enemy)).toBe(1);
    expect(routines.GetTrapDetectedBy.kotor.call({}, trap, enemy)).toBe(1);
    expect(routines.GetTrapDetectedBy.kotor.call({}, trap, pc)).toBe(0);
    expect(trap.trapDetected).toBe(false); // an enemy knowing does not show it to the player

    expect(routines.SetTrapDetectedBy.kotor.call({}, trap, pc)).toBe(1);
    expect(trap.trapDetected).toBe(true);
    expect(routines.SetTrapDetectedBy.kotor.call({}, undefined, pc)).toBe(0);
  });

  test('TSL SpawnMine adds the traps.2da DC modifiers to the bases and is owned by the creator', () => {
    const pc = creature({ party: true });
    const location = { position: new THREE.Vector3(3, 4, 0), area };
    routines.SpawnMine.tsl.call({ caller: pc }, TRAP_FRAG, location, 15, 20, pc);
    const mine = area.triggers[area.triggers.length - 1] as ModuleTrigger;
    expect(mine.position.toArray()).toEqual([3, 4, 0]);
    expect(mine.trapDetectDC).toBe(20);
    expect(mine.trapDisarmDC).toBe(30);
    expect(routines.GetTrapCreator.kotor.call({}, mine)).toBe(pc);
    expect(routines.GetTrapDetectedBy.kotor.call({}, mine, pc)).toBe(1);
  });

  test('TSL SpawnMine without a creator is hostile to the party', () => {
    routines.SpawnMine.tsl.call({}, TRAP_FRAG, { position: new THREE.Vector3(0, 0, 0), area }, 10, 10, undefined);
    const mine = area.triggers[area.triggers.length - 1] as ModuleTrigger;
    expect(factionOf(mine)).toBe(FACTION_HOSTILE);
    expect(routines.GetTrapCreator.kotor.call({}, mine)).toBeUndefined();
    const pc = creature({ party: true, at: [0.5, 0.5] });
    mine.updateObjectInside(pc);
    expect(trapEvents()).toHaveLength(1);
  });

  test.each(['kotor', 'tsl'] as const)('%s routine table implements the trap/lock routines', (engine) => {
    const runtime = harness();
    const { isEngineRoutineFallback } = runtime.loadScript('engineRoutineFallbacks');
    const ids = engine == 'tsl' ? [349, 350, 486, 529, 533, 534, 550, 788] : [349, 350, 486, 529, 533, 534, 550];
    for (const id of ids) {
      expect([id, isEngineRoutineFallback(runtime[engine][id])]).toEqual([id, false]);
    }
  });
});

describe('trap state persists through save/load', () => {
  test('detect/disarm DCs, detection, and creator round-trip through the binary GFF', () => {
    const pc = creature({ party: true });
    const enemy = creature({ party: false, faction: FACTION_HOSTILE });
    const trap = trapTrigger({ detectDC: 22, disarmDC: 27 });
    trap.trapCreatorId = enemy.id;
    trap.detectTrap(pc);

    const reloaded = new ModuleTrigger(new GFFObject(trap.save().getExportBuffer()));
    expect(reloaded.trapDetectDC).toBe(22);
    expect(reloaded.trapDisarmDC).toBe(27);
    expect(reloaded.trapDetected).toBe(true);
    expect(reloaded.isTrapDetectedBy(pc)).toBe(true);
    expect(reloaded.isTrapDetectedBy(enemy)).toBe(false);
    expect(reloaded.getTrapCreator()).toBe(enemy);
  });

  test('an undetected toolset trap reloads undetected with no creator', () => {
    const trap = trapTrigger({ detectDC: 9, disarmDC: 11 });
    const reloaded = new ModuleTrigger(new GFFObject(trap.save().getExportBuffer()));
    expect(reloaded.trapDetected).toBe(false);
    expect(reloaded.trapDetectedByFactions.size).toBe(0);
    expect(reloaded.getTrapCreator()).toBeUndefined();
    expect(reloaded.trapDisarmDC).toBe(11);
  });
});

/*
 * Round 2 (critic of 044e0be): own mines, spent one-shots, the HUD mines slot,
 * OnFailToOpen ownership, old saves, the trap model load, item skill bonuses,
 * and tests for behaviour the first round left unpinned.
 */

function ofType(type: number){
  return events.filter(e => e.eventType == type);
}

describe('own mines are safe to handle', () => {
  test('the layer recovers its own mine with ordinary skill and gets the item back', () => {
    loadCachedResource.mockReturnValue(undefined);
    jest.spyOn(SWTrapRules, 'createMineItem').mockReturnValue({ tag: 'g_i_trapkit001' } as any);
    const pc = creature({ party: true, demolitions: 1, int: 10 }); // 1 + 20 = 21 >= setdc 15
    const { mine } = layAt(pc, 1, 0);
    const action = new ActionRecoverMine();
    action.setParameter(0, ActionParameterType.DWORD, mine);
    expect(runAction(action, pc)).toBe(ActionStatus.COMPLETE);
    expect(trapEvents()).toHaveLength(0);
    expect(mine.destroyed).toBe(true);
    expect(state.InventoryManager.addItem).toHaveBeenCalledWith({ tag: 'g_i_trapkit001' });
    expect(state.PartyManager.GiveXP).not.toHaveBeenCalled();
  });

  test('a companion disarms the party mine without a check and without XP', () => {
    const pc = creature({ party: true, demolitions: 1 });
    const { mine } = layAt(pc, 1, 0);
    const companion = creature({ party: true, demolitions: 0, int: 3, inCombat: true });
    d20(1);
    const action = new ActionDisarmMine();
    action.setParameter(0, ActionParameterType.DWORD, mine);
    expect(runAction(action, companion)).toBe(ActionStatus.COMPLETE);
    expect(trapEvents()).toHaveLength(0);
    expect(state.PartyManager.GiveXP).not.toHaveBeenCalled();
  });

  test('a party member walking onto a party mine does not set it off, even via fireTrap', () => {
    const pc = creature({ party: true, demolitions: 1 });
    const { mine } = layAt(pc, 0, 0);
    const companion = creature({ party: true, at: [0.5, 0.5] });
    mine.onEnter(companion);
    expect(mine.fireTrap(companion)).toBe(false);
    expect(trapEvents()).toHaveLength(0);
    expect(mine.trapSpent).toBe(false);
  });

  test('laying fails below the 2DA set DC: no mine, item kept, action FAILED', () => {
    const pc = creature({ party: true, demolitions: 0, int: 6, inCombat: true }); // -2 + 16 = 14 < 15
    d20(16);
    const before = area.triggers.length;
    const { status } = layAt(pc, 1, 1);
    expect(status).toBe(ActionStatus.FAILED);
    expect(area.triggers.length).toBe(before);
    expect(state.InventoryManager.removeItem).not.toHaveBeenCalled();
  });

  test('a mine laid by an enemy is not the party\'s: SetByPlayerParty 0, party-laid 1', () => {
    const pc = creature({ party: true, demolitions: 1 });
    const enemy = creature({ party: false, faction: FACTION_HOSTILE, demolitions: 1 });
    const own = SWTrapRules.layMine(pc, TRAP_FRAG, new THREE.Vector3(0, 0, 0)).trigger!;
    const theirs = SWTrapRules.layMine(enemy, TRAP_FRAG, new THREE.Vector3(5, 0, 0)).trigger!;
    expect(own.save().RootNode.getFieldByLabel('SetByPlayerParty').getValue()).toBe(1);
    expect(theirs.save().RootNode.getFieldByLabel('SetByPlayerParty').getValue()).toBe(0);
    expect(theirs.trapDetected).toBe(false);
  });
});

describe('a one-shot mine is spent once it goes off', () => {
  test('it cannot be detected, disarmed or recovered afterwards, and leaves the area', () => {
    const pc = creature({ party: true, demolitions: 40, awareness: 40 });
    const trap = trapTrigger({ at: [1, 0], detectDC: 1, disarmDC: 1 });
    expect(trap.fireTrap(pc)).toBe(true);
    expect(trap.fireTrap(pc)).toBe(false);
    expect(trapEvents()).toHaveLength(1);

    expect(SWTrapRules.attemptDisarm(pc, trap).outcome).toBe('invalid');
    expect(SWTrapRules.attemptRecover(pc, trap).outcome).toBe('invalid');
    expect(SWTrapRules.passiveDetect(pc, [trap])).toHaveLength(0);
    expect(trap.trapDetected).toBe(false);
    expect(routines.GetIsTrapped.kotor.call({}, trap)).toBe(0);
    expect(state.PartyManager.GiveXP).not.toHaveBeenCalled();
    expect(state.InventoryManager.addItem).not.toHaveBeenCalled();

    // Kept until its OnTrapTriggered script has had time to run, then removed.
    expect(trap.updateSpentTrap(SPENT_TRAP_REMOVE_DELAY / 2)).toBe(false);
    expect(area.triggers).toContain(trap);
    expect(trap.updateSpentTrap(SPENT_TRAP_REMOVE_DELAY)).toBe(true);
    expect(trap.destroyed).toBe(true);
    expect(area.triggers).not.toContain(trap);
  });

  test('a non-one-shot trap fires again and stays armed', () => {
    const pc = creature({ party: true });
    const trap = trapTrigger({ oneShot: 0 });
    expect(trap.fireTrap(pc)).toBe(true);
    expect(trap.fireTrap(pc)).toBe(true);
    expect(trap.trapSpent).toBe(false);
    expect(trap.updateSpentTrap(100)).toBe(false);
  });
});

describe('HUD self menu', () => {
  test('mines go in self slot 3 (PersonalMinesAct) and selecting one queues ActionSetMine at the PC', () => {
    state.GameKey = GameEngineType.KOTOR;
    state.ActionMenuManager = { ActionMenuPanel, ActionMenuItem };
    state.ActionFactory.ActionSetMine = ActionSetMine;
    const pc = creature({ party: true, at: [3, 4] });
    const item = mineItem();
    (item as any).baseItemId = 58;
    (item as any).getIcon = () => 'i_mine';
    jest.spyOn(pc, 'getInventory').mockReturnValue([item] as any);
    jest.spyOn(pc, 'getSpells').mockReturnValue([] as any);
    ActionMenuManager.InitActionMenuPanels();
    ActionMenuManager.SetPC(pc);
    ActionMenuManager.oTarget = undefined;
    ActionMenuManager.UpdateMenuActions();

    const panels = ActionMenuManager.ActionPanels.selfPanels;
    expect(panels[2].actions).toHaveLength(0);
    expect(panels[3].actions).toHaveLength(1);
    const setMine = panels[3].actions[0].action;
    expect(setMine).toBeInstanceOf(ActionSetMine);
    expect([setMine.getParameter(2), setMine.getParameter(3)]).toEqual([3, 4]);

    ActionMenuManager.onSelfMenuAction(3);
    expect(pc.actionQueue[0]).toBe(setMine);
  });
});

describe('OnFailToOpen is signalled exactly once per failed unlock', () => {
  test('DoDoorAction(DOOR_ACTION_UNLOCK) failure signals OnFailToOpen', () => {
    const pc = creature({ party: true, security: 1 });
    const door = lockedDoor(30);
    (doorRoutines as any).DoDoorAction.kotor.call({ caller: pc }, door, 1);
    expect(door.isLocked()).toBe(true);
    expect(ofType(SignalEventType.OnFailToOpen)).toHaveLength(1);
  });

  test('ActionUnlockObject failure signals OnFailToOpen once', () => {
    const pc = creature({ party: true, security: 1 });
    jest.spyOn(pc, 'setAnimationState').mockImplementation(() => {});
    jest.spyOn(pc, 'setFacingObject').mockImplementation(() => {});
    const door = lockedDoor(30);
    door.position.set(1, 0, 0);
    const action = new ActionUnlockObject();
    action.setParameter(0, ActionParameterType.DWORD, door);
    action.setParameter(1, ActionParameterType.DWORD, ModuleObjectConstant.OBJECT_INVALID);
    action.setOwner(pc);
    expect(action.update(5)).toBe(ActionStatus.COMPLETE);
    expect(ofType(SignalEventType.OnFailToOpen)).toHaveLength(1);
  });

  test('an NPC holding the key in its own inventory opens a KeyRequired door; one without fails once', () => {
    const npc = creature({ party: false, faction: FACTION_NEUTRAL });
    const door = lockedDoor(1, 1);
    expect(door.attemptUnlock(npc)).toBe(false);
    expect(ofType(SignalEventType.OnFailToOpen)).toHaveLength(1);
    npc.inventory.push({ tag: 'DOOR_KEY' } as any);
    expect(door.attemptUnlock(npc)).toBe(true);
    expect(door.isLocked()).toBe(false);
    expect(ofType(SignalEventType.OnFailToOpen)).toHaveLength(1);
  });

  test.each([
    ['door', lockedDoor],
    ['placeable', lockedPlaceable],
  ] as const)('%s: the party key opens a KeyRequired lock; AutoRemoveKey takes it', (_, make) => {
    const pc = creature({ party: true, security: 0 });
    const key = { tag: 'door_key' };
    state.InventoryManager.getItemByTag = jest.fn((tag: string) => tag == 'door_key' ? key : undefined);
    const removeItem = jest.spyOn(pc, 'removeItem').mockImplementation(() => undefined as any);
    const lock: any = make(99, 1);
    lock.autoRemoveKey = true;
    expect(lock.attemptUnlock(pc)).toBe(true);
    expect(lock.isLocked()).toBe(false);
    expect(lock.use).toHaveBeenCalledWith(pc);
    expect(removeItem).toHaveBeenCalledWith(key as any);
    expect(ofType(SignalEventType.OnFailToOpen)).toHaveLength(0);
  });

  test('an unlocked KeyRequired placeable does not consume its key again on use', () => {
    const pc = creature({ party: true });
    const key = { tag: 'door_key', objectType: ModuleObjectType.ModuleObject | ModuleObjectType.ModuleItem };
    state.InventoryManager.getItemByTag = jest.fn(() => key);
    const removeItem = jest.spyOn(pc, 'removeItem').mockImplementation(() => undefined as any);
    const plc = register(new ModulePlaceable(new GFFObject()));
    plc.keyRequired = true; plc.keyName = 'door_key'; plc.autoRemoveKey = true; plc.locked = false;
    plc.attemptUnlockWithKey(pc);
    expect(removeItem).not.toHaveBeenCalled();
  });
});

describe('older saves and models', () => {
  test('a saved trap without TrapDisarmDC/TrapDetectDC takes them from its traps.2da row', () => {
    const gff = new GFFObject();
    gff.RootNode.addField(new GFFField(GFFDataType.BYTE, 'Type')).setValue(ModuleTriggerType.TRAP);
    gff.RootNode.addField(new GFFField(GFFDataType.BYTE, 'TrapType')).setValue(TRAP_FRAG);
    const trap = new ModuleTrigger(gff);
    expect(trap.trapDisarmDC).toBe(25);
    expect(trap.trapDetectDC).toBe(20);
  });

  test('loading a trap model animates the trap model (triggers have no this.model)', async () => {
    const model: any = Object.assign(new THREE.Object3D(), { playAnimation: jest.fn() });
    const load = (MDLLoader as any).loader.load;
    (MDLLoader as any).loader.load = jest.fn(() => Promise.resolve({}));
    (OdysseyModel3D as any).FromMDL = jest.fn(() => Promise.resolve(model));
    try{
      TRAPS_2DA_ROWS[TRAP_FRAG].model = 'mine_frag';
      const trap = trapTrigger();
      await new Promise((r) => setImmediate(r));
      expect(trap.trapModel).toBe(model);
      expect(model.playAnimation).toHaveBeenCalledWith('default', false);
    }finally{
      TRAPS_2DA_ROWS[TRAP_FRAG].model = '';
      (MDLLoader as any).loader.load = load;
    }
  });
});

describe('skill totals', () => {
  function withProperty(type: number, subType: number, value: number){
    return {
      getINTBonus: () => 0,
      properties: [{ isUseable: () => true, is: (t: number, st?: number) => t == type && (st === undefined || st == subType), getValue: () => value }],
    };
  }

  test('equipped item Skill / DecreasedSkill properties count', () => {
    const pc = creature({ party: true, security: 2 });
    (pc as any).equipment.HEAD = withProperty(ModuleItemProperty.Skill, SkillType.SECURITY, 3);
    expect(SWSkillCheck.getSkillTotal(pc, SkillType.SECURITY)).toBe(5);
    (pc as any).equipment.ARMS = withProperty(ModuleItemProperty.DecreasedSkill, SkillType.SECURITY, 1);
    expect(SWSkillCheck.getSkillTotal(pc, SkillType.SECURITY)).toBe(4);
    (pc as any).equipment.BELT = withProperty(ModuleItemProperty.Skill, SkillType.AWARENESS, 9);
    expect(SWSkillCheck.getSkillTotal(pc, SkillType.SECURITY)).toBe(4);
  });

  test('SKILL_ALL_SKILLS (255) effects and EffectSkillDecrease count', () => {
    const pc = creature({ party: true, security: 2 });
    pc.effects.push({ type: GameEffectType.EffectSkillIncrease, getInt: (i: number) => [255, 4][i] } as any);
    expect(SWSkillCheck.getSkillTotal(pc, SkillType.SECURITY)).toBe(6);
    pc.effects.push({ type: GameEffectType.EffectSkillDecrease, getInt: (i: number) => [SkillType.SECURITY, 1][i] } as any);
    expect(SWSkillCheck.getSkillTotal(pc, SkillType.SECURITY)).toBe(5);
  });

  test('a skill flagged usable untrained may be used at rank 0', () => {
    const pc = creature({ party: true, security: 0 });
    const door = lockedDoor(20);
    expect(door.attemptUnlock(pc)).toBe(false);
    (pc.skills as any)[SkillType.SECURITY].untrained = true;
    expect(door.attemptUnlock(pc)).toBe(true);
  });

  test('a low ability gives a negative modifier rounded down (INT 9 is -1)', () => {
    const pc = creature({ party: true, security: 5, int: 9 }); // 5 - 1 + 20 = 24
    expect(lockedDoor(25).attemptUnlock(pc)).toBe(false);
    expect(lockedDoor(24).attemptUnlock(pc)).toBe(true);
  });
});

describe('remaining first-round behaviour', () => {
  test('recover refuses a mine that is not disarmable', () => {
    const pc = creature({ party: true, demolitions: 40 });
    const trap = trapTrigger({ at: [1, 0], disarmDC: 1, disarmable: 0 });
    const action = new ActionRecoverMine();
    action.setParameter(0, ActionParameterType.DWORD, trap);
    expect(runAction(action, pc)).toBe(ActionStatus.FAILED);
    expect(trap.destroyed).toBeFalsy();
  });

  test('disarming runs the trap OnDisarm script', () => {
    const pc = creature({ party: true, demolitions: 40 });
    const trap = trapTrigger({ at: [1, 0], disarmDC: 1 });
    const run = jest.fn();
    trap.scripts[ModuleObjectScript.TriggerOnDisarm] = { run } as any;
    expect(SWTrapRules.attemptDisarm(pc, trap).outcome).toBe('success');
    expect(run).toHaveBeenCalledWith(trap);
  });

  test('addTrap builds a proper square (no duplicated vertex)', () => {
    (NWScript as any).Load = jest.fn(() => ({}));
    const pc = creature({ party: true, demolitions: 2 });
    jest.spyOn(pc, 'getSkillLevel').mockReturnValue(2);
    const door = lockedDoor(1);
    door.area = area;
    door.addTrap(TRAP_FRAG, pc);
    const trigger = door.linkedToObject as ModuleTrigger;
    const keys = new Set(trigger.vertices.map((v: THREE.Vector3) => v.toArray().join(',')));
    expect(keys.size).toBe(4);
    expect(keys.has('2,-2,0')).toBe(true);
  });

  test('placeable lock records GetLastLocked', () => {
    const pc = creature({ party: true });
    const plc = lockedPlaceable(1);
    plc.locked = false;
    plc.lock(pc);
    expect(routines.GetLastLocked.kotor.call({ caller: plc })).toBe(pc);
  });

  test('ActionExamineMine with no target fails instead of throwing', () => {
    const pc = creature({ party: true });
    const action = new ActionExamineMine();
    action.setParameter(0, ActionParameterType.DWORD, ModuleObjectConstant.OBJECT_INVALID);
    action.setOwner(pc);
    expect(action.update(0)).toBe(ActionStatus.FAILED);
  });

  test('un-detecting a trap for the party hides it again', () => {
    const pc = creature({ party: true });
    const trap = trapTrigger();
    trap.detectTrap(pc);
    expect(trap.trapDetected).toBe(true);
    trap.setTrapDetectedBy(pc, false);
    expect(trap.trapDetected).toBe(false);
    expect(trap.isTrapDetectedBy(pc)).toBe(false);
  });

  test('GetTrapKeyTag ignores a door lock key; GetLastTrapDetected drops removed traps', () => {
    const pc = creature({ party: true });
    const door = lockedDoor(1, 1);
    expect(routines.GetTrapKeyTag.kotor.call({}, door)).toBe('');
    const trap = trapTrigger();
    trap.detectTrap(pc);
    expect(routines.GetLastTrapDetected.kotor.call({ caller: pc }, pc)).toBe(trap);
    trap.destroy();
    expect(routines.GetLastTrapDetected.kotor.call({ caller: pc }, pc)).toBeUndefined();
  });

  test('SetTrapDetectedBy works on a trapped door', () => {
    const pc = creature({ party: true });
    const door = lockedDoor(1);
    door.trapFlag = true;
    expect(routines.SetTrapDetectedBy.kotor.call({}, door, pc)).toBe(1);
    expect(routines.GetTrapDetectedBy.kotor.call({}, door, pc)).toBe(1);
  });

  test('dead party members and already-known traps are not re-rolled', () => {
    const pc = creature({ party: true, awareness: 40, inCombat: true });
    const trap = trapTrigger({ at: [1, 0], detectDC: 1 });
    const roll = d20(10, 10, 10);
    (pc.isDead as jest.Mock).mockReturnValue(true);
    expect(SWTrapRules.passiveDetect(pc, [trap])).toHaveLength(0);
    (pc.isDead as jest.Mock).mockReturnValue(false);
    expect(SWTrapRules.passiveDetect(pc, [trap])).toHaveLength(1);
    expect(SWTrapRules.passiveDetect(pc, [trap])).toHaveLength(0);
    expect(roll).toHaveBeenCalledTimes(1);
  });
});

/*
 * Round 3 (critic of 708364d): the party is one owner although the PC is
 * faction 0 and companions keep their UTC faction; disabled traps are inert;
 * a spent trap stays spent through save/load; remaining mutant survivors.
 */

describe('the party is one owner (PC faction 0, companion faction 2)', () => {
  test.each([
    ['PC lays, companion recovers', FACTION_PC, FACTION_PARTY],
    ['companion lays, PC recovers', FACTION_PARTY, FACTION_PC],
  ] as const)('%s: no check, no XP, item back', (_, layerFaction, otherFaction) => {
    jest.spyOn(SWTrapRules, 'createMineItem').mockReturnValue({ tag: 'g_i_trapkit001' } as any);
    const layer = creature({ party: true, faction: layerFaction, demolitions: 1 });
    const other = creature({ party: true, faction: otherFaction, demolitions: 0, int: 3, inCombat: true });
    const { mine } = layAt(layer, 1, 0);
    const roll = d20(1);
    const result = SWTrapRules.attemptRecover(other, mine);
    expect(result.outcome).toBe('success');
    expect(result.check).toBeUndefined();
    expect(roll).not.toHaveBeenCalled();
    expect(state.PartyManager.GiveXP).not.toHaveBeenCalled();
    expect(state.InventoryManager.addItem).toHaveBeenCalledWith({ tag: 'g_i_trapkit001' });
    expect(trapEvents()).toHaveLength(0);
  });

  test('a mine the PC laid never fires on a companion of another faction', () => {
    const pc = creature({ party: true, faction: FACTION_PC, demolitions: 1 });
    const { mine } = layAt(pc, 0, 0);
    const companion = creature({ party: true, faction: FACTION_HOSTILE, at: [0.5, 0.5] }); // even a hostile-faction companion
    mine.updateObjectInside(companion);
    expect(mine.fireTrap(companion)).toBe(false);
    expect(trapEvents()).toHaveLength(0);
  });

  test('an NPC of the PC faction does not own a party mine', () => {
    const pc = creature({ party: true, faction: FACTION_PC, demolitions: 1 });
    const { mine } = layAt(pc, 1, 0);
    const npc = creature({ party: false, faction: FACTION_PC, demolitions: 0 });
    expect(SWTrapRules.isOwnMine(npc, mine)).toBe(false);
    expect(SWTrapRules.isOwnMine(pc, mine)).toBe(true);
  });

  test('detection by the PC counts for the companions: no re-roll, GetTrapDetectedBy TRUE', () => {
    const pc = creature({ party: true, faction: FACTION_PC, awareness: 40, inCombat: true });
    const companion = creature({ party: true, faction: FACTION_PARTY, awareness: 40, inCombat: true });
    const enemy = creature({ party: false, faction: FACTION_HOSTILE });
    const trap = trapTrigger({ at: [1, 0], detectDC: 1 });
    const roll = d20(10, 10);
    expect(SWTrapRules.passiveDetect(pc, [trap])).toHaveLength(1);
    expect(SWTrapRules.passiveDetect(companion, [trap])).toHaveLength(0);
    expect(roll).toHaveBeenCalledTimes(1);
    expect(routines.GetTrapDetectedBy.kotor.call({}, trap, companion)).toBe(1);
    expect(routines.GetTrapDetectedBy.kotor.call({}, trap, enemy)).toBe(0);
    const reloaded = new ModuleTrigger(new GFFObject(trap.save().getExportBuffer()));
    expect(reloaded.isTrapDetectedBy(companion)).toBe(true);
  });

  test('a big failure on a trap that is not hostile reports failed, not triggered', () => {
    const companion = creature({ party: true, demolitions: 0, int: 3, inCombat: true });
    const trap = trapTrigger({ at: [1, 0], disarmDC: 30, faction: FACTION_NEUTRAL });
    d20(1, 1);
    expect(SWTrapRules.attemptDisarm(companion, trap).outcome).toBe('failed');
    expect(SWTrapRules.attemptRecover(companion, trap).outcome).toBe('failed');
    expect(trapEvents()).toHaveLength(0);
  });
});

describe('a disabled trap (SetTrapDisabled / TrapFlag 0) is inert', () => {
  test('it does not fire, is not detected and cannot be disarmed for XP', () => {
    const { SetTrapDisabled } = require('@/nwscript/builtins/upstream/world');
    const pc = creature({ party: true, awareness: 40, demolitions: 40, at: [0.5, 0.5] });
    const trap = trapTrigger({ at: [0, 0], detectDC: 1, disarmDC: 1 });
    expect(trap.canTrigger(pc)).toBe(true);
    SetTrapDisabled.action.call({}, [trap]);
    expect(trap.canTrigger(pc)).toBe(false);
    trap.updateObjectInside(pc);
    expect(trap.fireTrap(pc)).toBe(false);
    expect(trapEvents()).toHaveLength(0);
    expect(SWTrapRules.passiveDetect(pc, [trap])).toHaveLength(0);
    expect(SWTrapRules.attemptDisarm(pc, trap).outcome).toBe('invalid');
    expect(state.PartyManager.GiveXP).not.toHaveBeenCalled();
  });

  test('a trap trigger without a TrapFlag field is armed', () => {
    const gff = new GFFObject();
    gff.RootNode.addField(new GFFField(GFFDataType.BYTE, 'Type')).setValue(ModuleTriggerType.TRAP);
    gff.RootNode.addField(new GFFField(GFFDataType.DWORD, 'Faction')).setValue(FACTION_HOSTILE);
    const trap = new ModuleTrigger(gff);
    expect(trap.isTrapArmed()).toBe(true);
    expect(trap.fireTrap(creature({ party: true }))).toBe(true);
  });
});

describe('a spent one-shot trap stays spent through save/load', () => {
  test('quicksave right after the blast: the reload neither refires nor pays out, and is removed', () => {
    const pc = creature({ party: true, awareness: 40, demolitions: 40, at: [0.5, 0.5] });
    const trap = trapTrigger({ at: [0, 0], detectDC: 1, disarmDC: 1 });
    expect(trap.fireTrap(pc)).toBe(true);
    const reloaded = register(new ModuleTrigger(new GFFObject(trap.save().getExportBuffer())));
    reloaded.load();
    area.attachObject(reloaded);
    expect(reloaded.trapSpent).toBe(true);
    expect(reloaded.canTrigger(pc)).toBe(false);
    expect(reloaded.fireTrap(pc)).toBe(false);
    expect(SWTrapRules.passiveDetect(pc, [reloaded])).toHaveLength(0);
    expect(SWTrapRules.attemptDisarm(pc, reloaded).outcome).toBe('invalid');
    expect(trapEvents()).toHaveLength(1);
    expect(reloaded.updateSpentTrap(0)).toBe(true);
    expect(area.triggers).not.toContain(reloaded);
  });
});

describe('round 2 survivors', () => {
  test('a detected mine stops showing once spent', () => {
    const pc = creature({ party: true });
    const trap = trapTrigger();
    trap.detectTrap(pc);
    expect(trap.trapDetected).toBe(true);
    trap.fireTrap(pc);
    expect(trap.trapDetected).toBe(false);
  });

  test('an item skill property that needs a missing upgrade does not count', () => {
    const pc = creature({ party: true, security: 2 });
    (pc as any).equipment.HEAD = {
      getINTBonus: () => 0,
      properties: [{ isUseable: () => false, is: (t: number, st?: number) => t == ModuleItemProperty.Skill && st == SkillType.SECURITY, getValue: () => 5 }],
    };
    expect(SWSkillCheck.getSkillTotal(pc, SkillType.SECURITY)).toBe(2);
  });

  test('traps.2da detectdc/disarmdc base columns are used when present', () => {
    expect(SWTrapRules.rowDCs(TRAPS_2DA_ROWS[TRAP_GAS])).toEqual({ setDC: 12, detectDC: 19, disarmDC: 24 });
    const pc = creature({ party: true, demolitions: 1 });
    const mine = SWTrapRules.layMine(pc, TRAP_GAS, new THREE.Vector3(0, 0, 0)).trigger!;
    expect([mine.trapDetectDC, mine.trapDisarmDC]).toEqual([19, 24]);
  });

  test('picking plays the fail sound on failure and the success sound on success', () => {
    const pc = creature({ party: true, security: 1 });
    const sound = pc.playSoundSet as unknown as jest.Mock;
    expect(lockedDoor(30).attemptUnlock(pc)).toBe(false);
    expect(sound).toHaveBeenLastCalledWith(SSFType.UNLOCK_FAIL);
    expect(lockedDoor(1).attemptUnlock(pc)).toBe(true);
    expect(sound).toHaveBeenLastCalledWith(SSFType.UNLOCK_SUCCESS);
  });
});

/*
 * Round 4 (critic of 2ecf704): a party member never uses up a party mine,
 * effective TrapFlag/TrapOneShot survive save/load, disabling hides the trap,
 * and party membership comes from PartyManager.party rather than isPM.
 */

/** A TRAP trigger built without TrapFlag/TrapOneShot fields. */
function bareTrapTrigger(): ModuleTrigger {
  const gff = new GFFObject();
  gff.RootNode.addField(new GFFField(GFFDataType.BYTE, 'Type')).setValue(ModuleTriggerType.TRAP);
  gff.RootNode.addField(new GFFField(GFFDataType.BYTE, 'TrapType')).setValue(TRAP_FRAG);
  gff.RootNode.addField(new GFFField(GFFDataType.DWORD, 'Faction')).setValue(FACTION_HOSTILE);
  const geometry = gff.RootNode.addField(new GFFField(GFFDataType.LIST, 'Geometry'));
  for (const [x, y] of [[-1, 1], [-1, -1], [1, -1], [1, 1]]) {
    const v = new GFFStruct();
    v.addField(new GFFField(GFFDataType.FLOAT, 'PointX')).setValue(x);
    v.addField(new GFFField(GFFDataType.FLOAT, 'PointY')).setValue(y);
    v.addField(new GFFField(GFFDataType.FLOAT, 'PointZ')).setValue(0);
    geometry.addChildStruct(v);
  }
  const t = register(new ModuleTrigger(gff));
  t.load();
  area.attachObject(t);
  return t;
}

function reload(trap: ModuleTrigger): ModuleTrigger {
  const t = register(new ModuleTrigger(new GFFObject(trap.save().getExportBuffer())));
  t.load();
  area.attachObject(t);
  return t;
}

describe('a party member never uses up a party mine', () => {
  test('a hostile-faction companion walks over the PC\'s mine: no OnObjectEnter, still armed for the real enemy', () => {
    const pc = creature({ party: true, faction: FACTION_PC, demolitions: 1 });
    const { mine } = layAt(pc, 0, 0);
    const companion = creature({ party: true, faction: FACTION_HOSTILE, at: [0.5, 0.5] });
    expect(mine.canTrigger(companion)).toBe(false);
    mine.updateObjectInside(companion);
    companion.position.set(20, 20, 0);
    mine.updateObjectInside(companion);
    expect(ofType(SignalEventType.OnObjectEnter)).toHaveLength(0);
    expect(mine.triggered).toBe(false);

    const enemy = creature({ party: false, faction: FACTION_HOSTILE, at: [0.5, -0.5] });
    mine.updateObjectInside(enemy);
    expect(trapEvents()).toHaveLength(1);
    expect(trapEvents()[0].caller).toBe(enemy);
    expect(mine.triggered).toBe(true);
  });
});

describe('effective TrapFlag / TrapOneShot', () => {
  test('a trap with no TrapFlag/TrapOneShot fields reloads armed and one-shot', () => {
    const trap = bareTrapTrigger();
    expect(trap.isTrapArmed()).toBe(true);
    const reloaded = reload(trap);
    expect(reloaded.isTrapArmed()).toBe(true);
    expect(reloaded.isTrapOneShot()).toBe(true);
    const pc = creature({ party: true });
    expect(reloaded.fireTrap(pc)).toBe(true);
    expect(reloaded.fireTrap(pc)).toBe(false);
  });

  test('a generic trigger still saves TrapFlag/TrapOneShot as 0', () => {
    const gff = new GFFObject();
    gff.RootNode.addField(new GFFField(GFFDataType.BYTE, 'Type')).setValue(ModuleTriggerType.GENERIC);
    const generic = new ModuleTrigger(gff);
    const saved = generic.save().RootNode;
    expect(saved.getFieldByLabel('TrapFlag').getValue()).toBe(0);
    expect(saved.getFieldByLabel('TrapOneShot').getValue()).toBe(0);
  });

  test('a TrapFlag 0 trap loaded from a GFF is inert', () => {
    const pc = creature({ party: true, awareness: 40, demolitions: 40, at: [0.5, 0.5] });
    const trap = trapTrigger({ at: [0, 0], flag: 0, detectDC: 1, disarmDC: 1 });
    expect(trap.isTrapArmed()).toBe(false);
    trap.updateObjectInside(pc);
    expect(trap.fireTrap(pc)).toBe(false);
    expect(trapEvents()).toHaveLength(0);
    expect(SWTrapRules.passiveDetect(pc, [trap])).toHaveLength(0);
    expect(SWTrapRules.attemptDisarm(pc, trap).outcome).toBe('invalid');
  });

  test('GetIsTrapped / GetTrapFlagged / GetTrapOneShot agree with the engine', () => {
    const pc = creature({ party: true });
    const bare = bareTrapTrigger();
    const disabled = trapTrigger({ flag: 0 });
    const spent = trapTrigger();
    spent.fireTrap(pc);

    expect(routines.GetIsTrapped.kotor.call({}, bare)).toBe(1);
    expect(routines.GetTrapFlagged.kotor.call({}, bare)).toBe(1);
    expect(routines.GetTrapOneShot.kotor.call({}, bare)).toBe(1);
    expect(routines.GetTrapOneShot.kotor.call({}, trapTrigger({ oneShot: 0 }))).toBe(0);
    for (const t of [disabled, spent]) {
      expect(routines.GetIsTrapped.kotor.call({}, t)).toBe(0);
      expect(routines.GetTrapFlagged.kotor.call({}, t)).toBe(0);
    }
  });
});

describe('SetTrapDisabled hides the trap', () => {
  test('detection is cleared and the target menu offers nothing on it', () => {
    const { SetTrapDisabled } = require('@/nwscript/builtins/upstream/world');
    state.GameKey = GameEngineType.KOTOR;
    state.ActionMenuManager = { ActionMenuPanel, ActionMenuItem };
    state.ActionFactory.ActionDisarmMine = ActionDisarmMine;
    state.ActionFactory.ActionRecoverMine = ActionRecoverMine;
    state.ActionFactory.ActionSetMine = ActionSetMine;
    const pc = creature({ party: true, demolitions: 3 });
    jest.spyOn(pc, 'getInventory').mockReturnValue([] as any);
    jest.spyOn(pc, 'getSpells').mockReturnValue([] as any);
    const trap = trapTrigger({ at: [1, 0] });
    trap.detectTrap(pc);

    const targetActions = () => {
      ActionMenuManager.InitActionMenuPanels();
      ActionMenuManager.SetPC(pc);
      ActionMenuManager.oTarget = trap;
      ActionMenuManager.UpdateMenuActions();
      return ActionMenuManager.ActionPanels.targetPanels.flatMap((p: any) => p.actions.map((a: any) => a.action?.type));
    };
    expect(targetActions()).toEqual([ActionType.ActionDisarmMine, ActionType.ActionRecoverMine]);

    SetTrapDisabled.action.call({}, [trap]);
    expect(trap.trapDetected).toBe(false);
    expect(trap.isTrapDetectedBy(pc)).toBe(false);
    expect(targetActions()).toEqual([]);
  });
});

describe('party membership is PartyManager.party, not isPM', () => {
  test('a creature that left the party (isPM still set) is not the party', () => {
    const pc = creature({ party: true, faction: FACTION_PC, demolitions: 1 });
    const { mine } = layAt(pc, 1, 0);
    const former = creature({ party: false, faction: FACTION_PARTY });
    former.isPM = true; // RemovePartyMemberByNPCId splices party without clearing isPM
    expect(SWTrapRules.isOwnMine(former, mine)).toBe(false);
    expect(mine.isTrapDetectedBy(former)).toBe(false);
  });

  test('a party-array member whose isPM is unset is the party', () => {
    const pc = creature({ party: true, faction: FACTION_PC, demolitions: 1 });
    const { mine } = layAt(pc, 1, 0);
    const member = creature({ party: false, faction: FACTION_PARTY });
    state.PartyManager.party.push(member);
    expect(member.isPM).toBe(false);
    expect(SWTrapRules.isOwnMine(member, mine)).toBe(true);
    expect(mine.isTrapDetectedBy(member)).toBe(true);
  });
});

/*
 * Round 5 (critic of bf1ab70): routines called the way the VM calls them
 * (reconciled action map, VM argument order), and detection of traps that
 * are no longer live.
 */

describe('trap/lock routines through the reconciled action map, VM argument order', () => {
  let runtime: ReturnType<typeof harness>;
  beforeAll(() => { runtime = harness(); });
  const call = (engine: 'kotor' | 'tsl', id: number, caller: any, args: any[]) =>
    runtime[engine][id].action.call({ caller }, args);

  test.each(['kotor', 'tsl'] as const)('%s GetNearestTrapToObject(oTarget, nTrapDetected) returns the nearest armed trap', (engine) => {
    const pc = creature({ party: true, at: [0, 0] });
    const disabled = trapTrigger({ at: [0.5, 0], flag: 0 });
    const spent = trapTrigger({ at: [0.7, 0] });
    spent.fireTrap(pc);
    const hidden = trapTrigger({ at: [1, 0] });
    const known = trapTrigger({ at: [3, 0] });
    known.detectTrap(pc);
    area.doors = [Object.assign(lockedDoor(1), { trapFlag: true })];
    area.doors[0].position.set(5, 0, 0);
    area.placeables = [];
    disabled.detectTrap(pc);

    expect(call(engine, 488, pc, [pc, 1])).toBe(known);
    expect(call(engine, 488, pc, [pc, 0])).toBe(hidden);
    // OBJECT_SELF default resolves to the caller when the VM passes no object
    expect(call(engine, 488, pc, [undefined, 1])).toBe(known);
    known.disarmTrap(pc);
    expect(call(engine, 488, pc, [pc, 1])).toBeUndefined();
    hidden.disableTrap();
    expect(call(engine, 488, pc, [pc, 0])).toBe(area.doors[0]);
    area.doors = [];
    expect(call(engine, 488, pc, [pc, 0])).toBeUndefined();
  });

  test.each(['kotor', 'tsl'] as const)('%s the other trap/lock routines read their arguments in VM order', (engine) => {
    const pc = creature({ party: true });
    const enemy = creature({ party: false, faction: FACTION_HOSTILE });
    const trap = trapTrigger({ keyName: 'tk', detectDC: 7, disarmDC: 9, oneShot: 0 });
    trap.trapCreatorId = enemy.id;
    const door = lockedDoor(1);
    door.locked = false;
    door.lock(pc);
    door.unlock(enemy);

    expect(call(engine, 349, door, [])).toBe(pc);
    expect(call(engine, 350, door, [])).toBe(enemy);
    expect(call(engine, 550, undefined, [trap, pc])).toBe(1);
    expect(call(engine, 529, undefined, [trap, pc])).toBe(1);
    expect(call(engine, 529, undefined, [trap, enemy])).toBe(0);
    expect(call(engine, 486, pc, [pc])).toBe(trap);
    expect(call(engine, 533, undefined, [trap])).toBe(enemy);
    expect(call(engine, 534, undefined, [trap])).toBe('tk');
    expect(call(engine, 532, undefined, [trap])).toBe(0);
    expect(call(engine, 535, undefined, [trap])).toBe(9);
    expect(call(engine, 536, undefined, [trap])).toBe(7);
    expect(call(engine, 551, undefined, [trap])).toBe(1);
  });
});

describe('a trap that is not live cannot be detected', () => {
  test('SetTrapDetectedBy on a disabled trap reveals nothing and returns FALSE', () => {
    const { SetTrapDisabled } = require('@/nwscript/builtins/upstream/world');
    const pc = creature({ party: true });
    const trap = trapTrigger();
    SetTrapDisabled.action.call({}, [trap]);
    expect(routines.SetTrapDetectedBy.kotor.call({}, trap, pc)).toBe(0);
    expect(trap.trapDetected).toBe(false);
    expect(routines.GetTrapDetectedBy.kotor.call({}, trap, pc)).toBe(0);
    trap.setTrapDetectedBy(pc, true);
    expect(trap.isTrapDetectedBy(pc)).toBe(false);
  });

  test('a spent trap forgets who detected it', () => {
    const pc = creature({ party: true });
    const enemy = creature({ party: false, faction: FACTION_HOSTILE });
    const trap = trapTrigger();
    trap.detectTrap(pc);
    trap.setTrapDetectedBy(enemy, true);
    trap.fireTrap(pc);
    expect(routines.GetTrapDetectedBy.kotor.call({}, trap, pc)).toBe(0);
    expect(routines.GetTrapDetectedBy.kotor.call({}, trap, enemy)).toBe(0);
    expect(routines.SetTrapDetectedBy.kotor.call({}, trap, pc)).toBe(0);
  });

  test('a TrapFlag 0 trap saved as detected loads undetected', () => {
    const pc = creature({ party: true });
    const trap = trapTrigger();
    trap.detectTrap(pc);
    trap.trapFlag = false; // disabled without SetTrapDisabled (e.g. toolset/GIT data)
    const reloaded = reload(trap);
    expect(reloaded.trapDetected).toBe(false);
    expect(reloaded.isTrapDetectedBy(pc)).toBe(false);
  });
});

/*
 * Round 6 (critic of b325a32, passed with follow-ups): trapped doors and
 * placeables, GetTrapBaseType on non-traps, and GetNearestTrapToObject edges.
 */

describe('trapped doors and placeables', () => {
  test.each([
    ['door', () => lockedDoor(1)],
    ['placeable', () => lockedPlaceable(1)],
  ] as const)('%s: detection works while trapped, is refused once disabled, and SetTrapDisabled clears it', (_, make) => {
    const { SetTrapDisabled } = require('@/nwscript/builtins/upstream/world');
    const pc = creature({ party: true });
    const untrapped: any = make();
    expect(routines.SetTrapDetectedBy.kotor.call({}, untrapped, pc)).toBe(0);
    expect(routines.GetTrapDetectedBy.kotor.call({}, untrapped, pc)).toBe(0);

    const trapped: any = make();
    trapped.trapFlag = true;
    expect(routines.SetTrapDetectedBy.kotor.call({}, trapped, pc)).toBe(1);
    expect(routines.GetTrapDetectedBy.kotor.call({}, trapped, pc)).toBe(1);
    SetTrapDisabled.action.call({}, [trapped]);
    expect(routines.GetTrapDetectedBy.kotor.call({}, trapped, pc)).toBe(0);
    expect(routines.SetTrapDetectedBy.kotor.call({}, trapped, pc)).toBe(0);
    expect(routines.GetTrapDetectedBy.kotor.call({}, trapped, pc)).toBe(0);
  });

  test.each([
    ['door', (gff: GFFObject) => new ModuleDoor(gff)],
    ['placeable', (gff: GFFObject) => new ModulePlaceable(gff)],
  ] as const)('%s trap detection round-trips through save/load', (_, make) => {
    const pc = creature({ party: true });
    const enemy = creature({ party: false, faction: FACTION_HOSTILE });
    const trapped: any = register(make(new GFFObject()) as any);
    trapped.initProperties();
    trapped.trapFlag = true;
    trapped.setTrapDetectedBy(pc, true);
    const reloaded: any = make(new GFFObject(trapped.save().getExportBuffer()));
    reloaded.initProperties();
    expect(reloaded.trapFlag).toBe(true);
    expect(reloaded.isTrapDetectedBy(pc)).toBe(true);
    expect(reloaded.isTrapDetectedBy(enemy)).toBe(false);
  });
});

describe('GetTrapBaseType', () => {
  test('returns the trap type for traps and -1 for anything else', () => {
    const pc = creature({ party: true });
    const trap = trapTrigger();
    const door: any = lockedDoor(1);
    const generic = new ModuleTrigger(new GFFObject());
    expect(routines.GetTrapBaseType.kotor.call({}, trap)).toBe(TRAP_FRAG);
    expect(routines.GetTrapBaseType.kotor.call({}, pc)).toBe(-1);
    expect(routines.GetTrapBaseType.kotor.call({}, door)).toBe(-1);
    expect(routines.GetTrapBaseType.kotor.call({}, generic)).toBe(-1);
    door.trapFlag = true;
    door.trapType = TRAP_GAS;
    expect(routines.GetTrapBaseType.kotor.call({}, door)).toBe(TRAP_GAS);
  });
});

describe('GetNearestTrapToObject edges (VM order, reconciled K1 map)', () => {
  let runtime: ReturnType<typeof harness>;
  beforeAll(() => { runtime = harness(); });
  const nearestTrap = (caller: any, target: any, detected: number) =>
    runtime.kotor[488].action.call({ caller }, [target, detected]);

  test('a trap asking for its nearest trap does not get itself', () => {
    const a = trapTrigger({ at: [0, 0] });
    const b = trapTrigger({ at: [4, 0] });
    expect(nearestTrap(a, a, 0)).toBe(b);
  });

  test('a target in another area gets that area\'s trap; no area gives OBJECT_INVALID', () => {
    const pc = creature({ party: true, at: [0, 0] });
    trapTrigger({ at: [0.5, 0] }); // in the module area, close
    const otherArea: any = { triggers: [], doors: [], placeables: [], attachObject(o: any){ o.area = this; this.triggers.push(o); } };
    const far = trapTrigger({ at: [9, 0] });
    area.detachObject(far);
    otherArea.attachObject(far);
    runtime.gameState.module = { area }; // the module's own area, which must not be used as a fallback
    pc.area = otherArea;
    expect(nearestTrap(pc, pc, 0)).toBe(far);
    pc.area = undefined;
    expect(nearestTrap(pc, pc, 0)).toBeUndefined();
  });

  test('nTrapDetected TRUE means detected by oTarget: an NPC does not see the party\'s finds', () => {
    const pc = creature({ party: true, at: [0, 0] });
    const npc = creature({ party: false, faction: FACTION_HOSTILE, at: [0, 0] });
    const trap = trapTrigger({ at: [1, 0] });
    trap.detectTrap(pc);
    expect(nearestTrap(pc, pc, 1)).toBe(trap);
    expect(nearestTrap(npc, npc, 1)).toBeUndefined();
    expect(nearestTrap(npc, npc, 0)).toBe(trap);
  });

  test('trapped placeables are candidates', () => {
    const pc = creature({ party: true, at: [0, 0] });
    const chest: any = lockedPlaceable(1);
    chest.trapFlag = true;
    chest.position.set(2, 0, 0);
    area.placeables = [chest];
    area.doors = [];
    expect(nearestTrap(pc, pc, 0)).toBe(chest);
  });
});
