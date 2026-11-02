import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

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
import { SkillType } from '@/enums/nwscript/SkillType';
import { ModuleItemProperty } from '@/enums/module/ModuleItemProperty';
import { Dice } from '@/utility/Dice';
import { ModuleCreature } from '@/module/ModuleCreature';
import { ModuleTrigger } from '@/module/ModuleTrigger';
import { ModuleDoor } from '@/module/ModuleDoor';
import { ModulePlaceable } from '@/module/ModulePlaceable';
import { ModuleItem } from '@/module/ModuleItem';
import { ActionDisarmMine } from '@/actions/ActionDisarmMine';
import { ActionRecoverMine } from '@/actions/ActionRecoverMine';
import { ActionFlagMine } from '@/actions/ActionFlagMine';
import { ActionSetMine } from '@/actions/ActionSetMine';
import * as trapRoutines from '@/nwscript/builtins/traps';
import { harness } from './nwscript/routineHarness';

const state = GameState as any;
const routines = trapRoutines as any;
const loadCachedResource = ResourceLoader.loadCachedResource as unknown as jest.Mock<(...args: any[]) => any>;

const FACTION_HOSTILE = 1;
const FACTION_PARTY = 2;
const FACTION_NEUTRAL = 5;

const TRAP_FRAG = 0;
const TRAPS_2DA_ROWS: Record<number, any> = {
  [TRAP_FRAG]: {
    label: 'FragMineMinor', name: '1', trapscript: 'k_trp_frag',
    detectdcmod: '5', disarmdcmod: '10', resref: 'g_i_trapkit001', model: '', explosionsound: 'exp_frag',
  },
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
  faction?: number, keyName?: string, oneShot?: number,
} = {}): ModuleTrigger {
  const gff = new GFFObject();
  const add = (type: GFFDataType, label: string, value: any) => gff.RootNode.addField(new GFFField(type, label)).setValue(value);
  add(GFFDataType.BYTE, 'Type', ModuleTriggerType.TRAP);
  add(GFFDataType.BYTE, 'TrapType', TRAP_FRAG);
  add(GFFDataType.BYTE, 'TrapFlag', 1);
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
  for (const id of [FACTION_HOSTILE, FACTION_PARTY, FACTION_NEUTRAL]) factions.set(id, { id });
  const hostile = (a: any, b: any) => {
    const fa = factionOf(a), fb = factionOf(b);
    return (fa == FACTION_HOSTILE && fb == FACTION_PARTY) || (fa == FACTION_PARTY && fb == FACTION_HOSTILE);
  };

  state.SWRuleSet = { skills: [], ranges: [], portraits: [], feats: [], classes: [] };
  state.ModuleObjectManager = {
    AddObjectById: jest.fn(),
    GetNextPlayerId: jest.fn(() => 1),
    GetObjectById: (id: number) => registry.get(id),
  };
  state.FactionManager = { factions, AddCreatureToFaction: jest.fn(), IsHostile: hostile };
  state.AppearanceManager = { GetCreatureAppearanceById: (): undefined => undefined };
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
  state.Module = { ModuleArea: { ModuleTrigger, ModuleItem } };
});

afterEach(() => jest.restoreAllMocks());

function BitWise_isTrigger(o: any){
  return ((o?.objectType ?? 0) & ModuleObjectType.ModuleTrigger) == ModuleObjectType.ModuleTrigger;
}

function queuedFlagMines(c: ModuleCreature){
  const queue: any[] = Array.from(c.actionQueue as any);
  return queue.filter(a => a?.type == ActionType.ActionFlagMine).length;
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
    const status = runAction(action, pc);
    return { status, item, mine: area.triggers[area.triggers.length - 1] as ModuleTrigger };
  }

  test('creates a party-owned mine trigger on the ground and uses up the item', () => {
    const pc = creature({ party: true, demolitions: 4, int: 12 });
    const { status, item, mine } = layAt(pc, 1, 1);
    expect(status).toBe(ActionStatus.COMPLETE);
    expect(mine).toBeInstanceOf(ModuleTrigger);
    expect(mine.type).toBe(ModuleTriggerType.TRAP);
    expect(mine.trapType).toBe(TRAP_FRAG);
    expect(mine.position.toArray()).toEqual([1, 1, 0]);
    expect(factionOf(mine)).toBe(FACTION_PARTY);
    // 2DA mod + Demolitions (4 + 1) + take-20
    expect(mine.trapDetectDC).toBe(5 + 5 + 20);
    expect(mine.trapDisarmDC).toBe(10 + 5 + 20);
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
    jest.spyOn(plc, 'use').mockImplementation(() => {});
    return plc;
  }

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
