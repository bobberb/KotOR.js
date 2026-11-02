import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

// Browser/asset boundaries are stubbed; combat round, action queue, actions, talents,
// creature FP/DC math, the action menu builder and the NWScript routine bodies all run for real.
jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/utility/GameFileSystem', () => ({ GameFileSystem: {} }));
jest.mock('@/loaders/ResourceLoader', () => ({ ResourceLoader: {} }));
jest.mock('@/loaders', () => ({
  MDLLoader: { loader: { load: jest.fn(() => new Promise(() => {})) } },
  ResourceLoader: {}, TextureLoader: {},
}));
jest.mock('@/odyssey', () => ({
  OdysseyModel: class {}, OdysseyModelAnimation: class { static GetAnimation2DA(): any { return undefined; } }, OdysseyWalkMesh: class {},
}));
jest.mock('@/three/odyssey', () => {
  const THREE = jest.requireActual<typeof import('three')>('three');
  return { OdysseyModel3D: class {}, OdysseyObject3D: THREE.Object3D, OdysseyLightsaberEffect: class {} };
});
jest.mock('@/nwscript/NWScript', () => ({ NWScript: class {} }));
jest.mock('@/nwscript/NWScriptInstance', () => ({ NWScriptInstance: class {} }));
jest.mock('@/nwscript/events', () => ({ NWScriptEvent: class {} }));
jest.mock('@/engine/CollisionManager', () => ({ CollisionManager: class {} }));
jest.mock('@/audio/AudioEmitter', () => ({ AudioEmitter: class { constructor(..._args: unknown[]) {} setPriorityGroupId(): void {} load(): void {} } }));
jest.mock('@/audio/AudioEngine', () => ({ AudioEngine: { GetAudioEngine: (): any => ({}) } }));
// CheatConsoleManager pulls the whole module barrel; only ModuleItem is referenced and heal() does not use it.
jest.mock('@/module', () => ({ ModuleItem: class {} }));

import { GameState } from '@/GameState';
import { MDLLoader } from '@/loaders';
import { ActionCastSpell } from '@/actions/ActionCastSpell';
import { ActionCombat } from '@/actions/ActionCombat';
import { ActionMoveToPoint } from '@/actions/ActionMoveToPoint';
import { TalentSpell } from '@/talents/TalentSpell';
import { TalentFeat } from '@/talents/TalentFeat';
import { TalentSkill } from '@/talents/TalentSkill';
import { TwoDAManager } from '@/managers/TwoDAManager';
import { CheatConsoleManager } from '@/managers/CheatConsoleManager';
import { ModuleCreature } from '@/module/ModuleCreature';
import { ModuleObject } from '@/module/ModuleObject';
import { SpellCastInstance } from '@/combat/SpellCastInstance';
import { ActionMenuManager } from '@/engine/menu/ActionMenuManager';
import EngineLocation from '@/engine/EngineLocation';
import { GFFObject } from '@/resource/GFFObject';
import { GFFField } from '@/resource/GFFField';
import { GFFDataType } from '@/enums/resource/GFFDataType';
import { ActionType } from '@/enums/actions/ActionType';
import { CombatActionType } from '@/enums/combat/CombatActionType';
import { GameEngineType } from '@/enums/engine/GameEngineType';
import { TalentObjectType } from '@/enums/engine/TalentObjectType';
import { ModuleObjectConstant } from '@/enums/module/ModuleObjectConstant';
import { ActionCastSpellAtObject, GetSpellSaveDC } from '@/nwscript/builtins/miscLegacy';
import { GetSpellTargetObject, GetSpellId } from '@/nwscript/builtins/combat';
import { ActionUseTalentOnObject } from '@/nwscript/builtins/talents';
import { ActionCastSpellAtLocation, ActionCastFakeSpellAtLocation, GetSpellTargetLocation } from '@/nwscript/builtins/objects/spellcasting';
import { ActionCastFakeSpellAtObject } from '@/nwscript/builtins/upstream/creatures';

const SPELL_ID = 7;
const SPELL_COST = 10;
const IMPACT_SCRIPT = 'k_sp_testpower';

/** A spells.2da row as TwoDAObject would deliver it: every cell a string, `****` for empty. */
function spellRow(overrides: Record<string, string> = {}){
  return {
    __rowlabel: String(SPELL_ID), label: 'FORCE_POWER_TEST', name: '1000', spelldesc: '1001',
    forcepoints: String(SPELL_COST), goodevil: '-', usertype: '1', range: 'M', iconresref: 'ip_test',
    impactscript: IMPACT_SCRIPT, conjtime: '1500', conjanim: 'hand', castanim: 'self', casttime: '1000',
    casthandvisual: '****', projmodel: '****', forcehostile: '1', forcefriendly: '****', hostilesetting: '1',
    ...overrides,
  };
}

interface ImpactRun { caller: any; spellTarget: any; spellId: number; saveDC: number; location: { x: number, y: number, z: number }; }
let objects: Map<number, ModuleObject>;
let spellInstances: SpellCastInstance[];
let impactRuns: ImpactRun[];
let nextId = 1;

function installSpells(rows: Record<number, any>){
  TwoDAManager.datatables = new Map([['spells', { rows } as any]]);
}

type FP = { base: number, max: number | undefined, current: number };
function makeCreature(fp: FP = { base: 20, max: 20, current: 20 }): ModuleCreature {
  const creature = new ModuleCreature();
  creature.id = nextId++;
  creature.forcePoints = fp.base;
  creature.maxForcePoints = fp.max;
  creature.currentForce = fp.current;
  creature.area = GameState.module.area as any;
  creature.actionQueue.setOwner(creature);
  objects.set(creature.id, creature);
  return creature;
}

/** Simulates the engine frame loop for the parts that drive a cast. */
function tick(objectsToTick: ModuleObject[], seconds = 6, delta = 0.05){
  for(let t = 0; t < seconds - 1e-9; t += delta){
    for(const object of objectsToTick){
      object.actionQueue.process(delta);
      object.combatRound.update(delta);
    }
    for(const instance of spellInstances.slice()){
      instance.update(delta);
      if(instance.completed) spellInstances.splice(spellInstances.indexOf(instance), 1);
    }
  }
}

function location(x: number, y: number, z: number){
  return new EngineLocation(x, y, z);
}

beforeEach(() => {
  objects = new Map();
  spellInstances = [];
  impactRuns = [];
  installSpells({ [SPELL_ID]: spellRow() });
  const state = GameState as any;
  state.TalentSpell = TalentSpell;
  state.TwoDAManager = TwoDAManager;
  state.ActionFactory = { ActionCastSpell, ActionCombat, ActionMoveToPoint };
  state.ModuleObjectManager = {
    GetObjectById: (id: number) => objects.get(id),
    AddObjectById: (): void => {},
    GetNextPlayerId: () => nextId++,
  };
  state.module = { area: { id: 1, attachSpellInstance: (instance: SpellCastInstance) => spellInstances.push(instance) } };
  state.PartyManager = { party: [] };
  state.SWRuleSet = { ranges: [], skills: [] };
  state.GameKey = GameEngineType.KOTOR;
  // The impact script runs the real NWScript routine bodies, the way the compiled script would.
  state.NWScript = {
    Load: jest.fn((name: string) => ({
      name,
      talent: undefined as any,
      caller: undefined as any,
      run(caller: any){
        this.caller = caller;
        const where = GetSpellTargetLocation.kotor.call(this) as EngineLocation;
        impactRuns.push({
          caller,
          spellTarget: GetSpellTargetObject.kotor.call(this),
          spellId: GetSpellId.kotor.call(this),
          saveDC: GetSpellSaveDC.kotor.call(this),
          location: { x: where.position.x, y: where.position.y, z: where.position.z },
        });
      },
      getSpellId(){ return this.talent ? this.talent.id : -1; },
    })),
  };
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('force power casting', () => {
  test('player cast from the action menu path impacts once with spell target/id/location and spends FP', () => {
    const caster = makeCreature();
    const target = makeCreature();
    target.position.set(3, 4, 0);
    const spell = new TalentSpell(SPELL_ID);
    expect(spell.impactscript).toBe(IMPACT_SCRIPT);

    spell.useTalentOnObject(target, caster);
    tick([caster, target]);

    expect(GameState.NWScript.Load).toHaveBeenCalledTimes(1);
    expect(GameState.NWScript.Load).toHaveBeenCalledWith(IMPACT_SCRIPT);
    expect(impactRuns).toHaveLength(1);
    expect(impactRuns[0].caller).toBe(caster);
    expect(impactRuns[0].spellTarget).toBe(target);
    expect(impactRuns[0].spellId).toBe(SPELL_ID);
    expect(impactRuns[0].location).toEqual({ x: 3, y: 4, z: 0 });
    expect(caster.getFP()).toBe(20 - SPELL_COST);
    expect(target.combatData.lastSpellAttacker).toBe(caster);
    // The round finished and nothing is left hanging in the queue.
    expect(caster.combatRound.roundStarted).toBe(false);
    expect(caster.actionQueue.length).toBe(0);
    expect(spellInstances).toHaveLength(0);
  });

  test('the round action queued by the talent is the one the cast runs under', () => {
    const caster = makeCreature();
    const target = makeCreature();
    new TalentSpell(SPELL_ID).useTalentOnObject(target, caster);
    const queued = caster.combatRound.scheduledActionList[0];
    tick([caster, target], 0.2);
    expect(caster.combatRound.action).toBe(queued);
  });

  test('spell target and attacker are visible from cast start, before impact', () => {
    const caster = makeCreature();
    const target = makeCreature();
    ActionCastSpellAtObject.kotor.call({ caller: caster } as any, SPELL_ID, target, 0, 0, 0, 0, 0);
    tick([caster, target], 0.2);
    expect(impactRuns).toHaveLength(0);
    expect(GetSpellTargetObject.kotor.call({ caller: caster } as any)).toBe(target);
    expect(target.combatData.lastSpellAttacker).toBe(caster);
  });

  test('impact re-asserts spell target/attacker cleared mid-conjure (e.g. by a new combat round)', () => {
    const caster = makeCreature();
    const target = makeCreature();
    new TalentSpell(SPELL_ID).useTalentOnObject(target, caster);
    tick([caster, target], 0.5);
    caster.combatData.lastSpellTarget = undefined;
    target.combatData.lastSpellAttacker = undefined;
    tick([caster, target], 3);
    expect(impactRuns).toHaveLength(1);
    expect(impactRuns[0].spellTarget).toBe(target);
    expect(target.combatData.lastSpellAttacker).toBe(caster);
  });

  test('impact timing follows conjtime from spells.2da', () => {
    const caster = makeCreature();
    const target = makeCreature();
    new TalentSpell(SPELL_ID).useTalentOnObject(target, caster);
    // conjtime 1500ms: nothing may land before conjuration finishes.
    tick([caster, target], 1.2);
    expect(impactRuns).toHaveLength(0);
    tick([caster, target], 2);
    expect(impactRuns).toHaveLength(1);
  });

  test('a short conjtime lands well inside the round', () => {
    installSpells({ [SPELL_ID]: spellRow({ conjtime: '500', casttime: '300' }) });
    const caster = makeCreature();
    const target = makeCreature();
    new TalentSpell(SPELL_ID).useTalentOnObject(target, caster);
    tick([caster, target], 0.4);
    expect(impactRuns).toHaveLength(0);
    tick([caster, target], 0.6);
    expect(impactRuns).toHaveLength(1);
  });

  test('long-range (L) powers land when the casttime flight ends, not when it starts', () => {
    installSpells({ [SPELL_ID]: spellRow({ range: 'L', conjtime: '500', casttime: '1000' }) });
    const caster = makeCreature();
    const target = makeCreature();
    new TalentSpell(SPELL_ID).useTalentOnObject(target, caster);
    tick([caster, target], 1.2);
    expect(impactRuns).toHaveLength(0);
    tick([caster, target], 0.6);
    expect(impactRuns).toHaveLength(1);
  });

  test('a spell row with no cast time still reaches impact', () => {
    installSpells({ [SPELL_ID]: spellRow({ casttime: '****', range: 'S' }) });
    const caster = makeCreature();
    const target = makeCreature();
    new TalentSpell(SPELL_ID).useTalentOnObject(target, caster);
    tick([caster, target]);
    expect(impactRuns).toHaveLength(1);
  });

  test('casthandvisual from spells.2da is loaded on impact', () => {
    installSpells({ [SPELL_ID]: spellRow({ casthandvisual: 'v_hand_test' }) });
    const caster = makeCreature();
    const target = makeCreature();
    new TalentSpell(SPELL_ID).useTalentOnObject(target, caster);
    tick([caster, target]);
    expect(MDLLoader.loader.load).toHaveBeenCalledWith('v_hand_test');
  });

  test('insufficient force points refuses the cast: no FP change, no impact', () => {
    const caster = makeCreature({ base: 20, max: 20, current: SPELL_COST - 1 });
    const target = makeCreature();
    const before = caster.getFP();
    expect(before).toBe(SPELL_COST - 1);

    new TalentSpell(SPELL_ID).useTalentOnObject(target, caster);
    tick([caster, target]);

    expect(caster.getFP()).toBe(before);
    expect(GameState.NWScript.Load).not.toHaveBeenCalled();
    expect(impactRuns).toHaveLength(0);
    expect(caster.actionQueue.actionTypeExists(ActionType.ActionCastSpell)).toBe(false);
  });

  test('exactly enough force points casts and empties the pool', () => {
    const caster = makeCreature({ base: 20, max: 20, current: SPELL_COST });
    const target = makeCreature();
    new TalentSpell(SPELL_ID).useTalentOnObject(target, caster);
    tick([caster, target]);
    expect(impactRuns).toHaveLength(1);
    expect(caster.getFP()).toBe(0);
  });

  test('free powers (forcepoints ****) cast without FP', () => {
    installSpells({ [SPELL_ID]: spellRow({ forcepoints: '****' }) });
    const caster = makeCreature({ base: 0, max: 0, current: 0 });
    const target = makeCreature();
    new TalentSpell(SPELL_ID).useTalentOnObject(target, caster);
    tick([caster, target]);
    expect(impactRuns).toHaveLength(1);
    expect(caster.getFP()).toBe(0);
  });

  test('a negative forcepoints cell never grants force points', () => {
    installSpells({ [SPELL_ID]: spellRow({ forcepoints: '-5' }) });
    const caster = makeCreature({ base: 20, max: 20, current: 10 });
    const target = makeCreature();
    new TalentSpell(SPELL_ID).useTalentOnObject(target, caster);
    tick([caster, target]);
    expect(impactRuns).toHaveLength(1);
    expect(caster.getFP()).toBe(10);
  });

  test('script-initiated ActionCastSpellAtObject does not throw, impacts once and spends FP', () => {
    const caster = makeCreature();
    const target = makeCreature();
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    ActionCastSpellAtObject.kotor.call({ caller: caster } as any, SPELL_ID, target, 0, 0, 0, 0, 0);
    expect(caster.actionQueue[0]).toBeInstanceOf(ActionCastSpell);
    expect(() => tick([caster, target])).not.toThrow();

    expect(errors).not.toHaveBeenCalled();
    expect(impactRuns).toHaveLength(1);
    expect(impactRuns[0].spellTarget).toBe(target);
    expect(impactRuns[0].spellId).toBe(SPELL_ID);
    expect(caster.getFP()).toBe(20 - SPELL_COST);
  });

  test('a second queued script cast waits for the first round to end', () => {
    const caster = makeCreature({ base: 40, max: 40, current: 40 });
    const target = makeCreature();
    ActionCastSpellAtObject.kotor.call({ caller: caster } as any, SPELL_ID, target, 0, 0, 0, 0, 0);
    ActionCastSpellAtObject.kotor.call({ caller: caster } as any, SPELL_ID, target, 0, 0, 0, 0, 0);
    tick([caster, target], 2.5);
    expect(impactRuns).toHaveLength(1);
    expect(caster.getFP()).toBe(40 - SPELL_COST);
    tick([caster, target], 5);
    expect(impactRuns).toHaveLength(2);
    expect(caster.getFP()).toBe(40 - 2 * SPELL_COST);
  });

  test('ActionCastSpellAtObject with an invalid target queues nothing', () => {
    const caster = makeCreature();
    expect(() => ActionCastSpellAtObject.kotor.call({ caller: caster } as any, SPELL_ID, undefined, 0, 0, 0, 0, 0)).not.toThrow();
    expect(caster.actionQueue.length).toBe(0);
  });

  test('a scripted cast whose target was destroyed before it ran fails quietly', () => {
    const caster = makeCreature();
    const target = makeCreature();
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    ActionCastSpellAtObject.kotor.call({ caller: caster } as any, SPELL_ID, target, 0, 0, 0, 0, 0);
    objects.delete(target.id);
    tick([caster]);
    expect(errors).not.toHaveBeenCalled();
    expect(impactRuns).toHaveLength(0);
    expect(caster.getFP()).toBe(20);
    expect(caster.actionQueue.length).toBe(0);
  });

  test('bCheat casts ignore FP and bInstantSpell skips conjuration', () => {
    const caster = makeCreature({ base: 0, max: 0, current: 0 });
    const target = makeCreature();
    ActionCastSpellAtObject.kotor.call({ caller: caster } as any, SPELL_ID, target, 0, 1, 0, 0, 1);
    tick([caster, target], 0.2);
    expect(impactRuns).toHaveLength(1);
    expect(caster.getFP()).toBe(0);
  });

  test('bCheat casts do not spend force points the caster has', () => {
    const caster = makeCreature();
    const target = makeCreature();
    ActionCastSpellAtObject.kotor.call({ caller: caster } as any, SPELL_ID, target, 0, 1, 0, 0, 0);
    tick([caster, target]);
    expect(impactRuns).toHaveLength(1);
    expect(caster.getFP()).toBe(20);
  });

  test('ActionUseTalentOnObject with a spell talent queues and resolves the cast', () => {
    const caster = makeCreature();
    const target = makeCreature();
    ActionUseTalentOnObject.kotor.call({ caller: caster } as any, new TalentSpell(SPELL_ID), target);
    tick([caster, target]);
    expect(impactRuns).toHaveLength(1);
    expect(impactRuns[0].spellTarget).toBe(target);
  });

  test('ActionUseTalentOnObject with a spell and OBJECT_INVALID drops the cast without throwing', () => {
    const caster = makeCreature();
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    ActionUseTalentOnObject.kotor.call({ caller: caster } as any, new TalentSpell(SPELL_ID), undefined);
    tick([caster]);
    expect(errors).not.toHaveBeenCalled();
    expect(impactRuns).toHaveLength(0);
    expect(caster.getFP()).toBe(20);
    expect(caster.actionQueue.length).toBe(0);
  });

  test('a non-creature caster (placeable) resolves its cast without a combat round', () => {
    const placeable = new ModuleObject();
    placeable.id = nextId++;
    placeable.area = GameState.module.area as any;
    placeable.actionQueue.setOwner(placeable);
    objects.set(placeable.id, placeable);
    const target = makeCreature();
    ActionCastSpellAtObject.kotor.call({ caller: placeable } as any, SPELL_ID, target, 0, 0, 0, 0, 0);
    ActionCastSpellAtObject.kotor.call({ caller: placeable } as any, SPELL_ID, target, 0, 0, 0, 0, 0);
    tick([placeable, target]);
    // Both casts resolve: nothing leaves the placeable's (never-updated) combat round paused.
    expect(impactRuns).toHaveLength(2);
    expect(impactRuns[0].caller).toBe(placeable);
    expect(placeable.combatRound.roundStarted).toBe(false);
    expect(placeable.combatRound.roundPaused).toBe(false);
    expect(placeable.actionQueue.length).toBe(0);
  });

  test('GetSpellTargetLocation in the impact script follows a target that moved during conjuration', () => {
    const caster = makeCreature();
    const target = makeCreature();
    target.position.set(1, 1, 0);
    new TalentSpell(SPELL_ID).useTalentOnObject(target, caster);
    tick([caster, target], 0.5);
    target.position.set(2, 3, 0);
    tick([caster, target], 3);
    expect(impactRuns).toHaveLength(1);
    expect(impactRuns[0].location).toEqual({ x: 2, y: 3, z: 0 });
  });
});

describe('location casts', () => {
  test('ActionCastSpellAtLocation from a creature impacts at the location and spends FP', () => {
    const caster = makeCreature();
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    ActionCastSpellAtLocation.kotor.call({ caller: caster } as any, SPELL_ID, location(5, 6, 1), 0, 0, 0, 0);
    tick([caster]);
    expect(errors).not.toHaveBeenCalled();
    expect(impactRuns).toHaveLength(1);
    expect(impactRuns[0].spellTarget).toBeUndefined();
    expect(impactRuns[0].location).toEqual({ x: 5, y: 6, z: 1 });
    expect(caster.getFP()).toBe(20 - SPELL_COST);
  });

  test('ActionCastSpellAtLocation honours bCheat and bInstantSpell', () => {
    const caster = makeCreature({ base: 0, max: 0, current: 0 });
    ActionCastSpellAtLocation.kotor.call({ caller: caster } as any, SPELL_ID, location(1, 2, 3), 0, 1, 0, 1);
    tick([caster], 0.2);
    expect(impactRuns).toHaveLength(1);
    expect(caster.getFP()).toBe(0);
  });
});

describe('fake casts (animation only)', () => {
  test('ActionCastFakeSpellAtObject plays the cast without impact or FP cost', () => {
    const caster = makeCreature();
    const target = makeCreature();
    (ActionCastFakeSpellAtObject as any).action.call({ caller: caster }, [SPELL_ID, target, 0]);
    const action = caster.actionQueue[0] as ActionCastSpell;
    expect(action.fake).toBe(true);
    tick([caster, target], 0.2);
    expect(caster.combatRound.action?.actionType).toBe(CombatActionType.CAST_SPELL);
    expect(caster.combatRound.action?.animationName).toBeTruthy();
    expect(spellInstances).toHaveLength(1);
    tick([caster, target]);
    expect(GameState.NWScript.Load).not.toHaveBeenCalled();
    expect(impactRuns).toHaveLength(0);
    expect(caster.getFP()).toBe(20);
    expect(target.combatData.lastSpellAttacker).toBeUndefined();
    expect(spellInstances).toHaveLength(0);
    expect(caster.actionQueue.length).toBe(0);
  });

  test('a caster with 0 FP still plays a fake cast', () => {
    const caster = makeCreature({ base: 0, max: 0, current: 0 });
    const target = makeCreature();
    (ActionCastFakeSpellAtObject as any).action.call({ caller: caster }, [SPELL_ID, target, 0]);
    tick([caster, target], 0.2);
    expect(caster.combatRound.roundStarted).toBe(true);
    expect(spellInstances).toHaveLength(1);
    tick([caster, target]);
    expect(impactRuns).toHaveLength(0);
    expect(caster.actionQueue.length).toBe(0);
  });

  test('ActionCastFakeSpellAtLocation plays without impact or FP cost', () => {
    const caster = makeCreature();
    ActionCastFakeSpellAtLocation.kotor.call({ caller: caster } as any, SPELL_ID, location(1, 1, 0), 0);
    tick([caster], 0.2);
    expect(spellInstances).toHaveLength(1);
    tick([caster]);
    expect(impactRuns).toHaveLength(0);
    expect(caster.getFP()).toBe(20);
  });
});

describe('force points', () => {
  test('subtractFP and addFP move getFP, capped at max', () => {
    const creature = makeCreature({ base: 15, max: 15, current: 10 });
    expect(creature.getFP()).toBe(10);
    creature.subtractFP(4);
    expect(creature.getFP()).toBe(6);
    creature.addFP(100);
    expect(creature.getFP()).toBe(15);
    creature.setFP(3);
    expect(creature.getFP()).toBe(3);
  });

  test('bonus force points (max above base) count toward current FP', () => {
    const creature = makeCreature({ base: 20, max: 26, current: 20 });
    expect(creature.getFP()).toBe(26);
    expect(creature.getMaxFP()).toBe(26);
    creature.subtractFP(10);
    expect(creature.getFP()).toBe(16);
    creature.setFP(26);
    expect(creature.getFP()).toBe(26);
  });

  test('UTC creature without MaxForcePoints: max defaults to ForcePoints; regen, heal and setFP work', () => {
    const creature = makeCreature({ base: 30, max: undefined, current: 30 });
    expect(creature.getMaxFP()).toBe(30);
    expect(creature.getFP()).toBe(30);
    creature.subtractFP(10);
    expect(creature.getFP()).toBe(20);
    creature.addFP(5); // updateRegen / EffectHealForcePoints path
    expect(creature.getFP()).toBe(25);
    creature.addFP(50);
    expect(creature.getFP()).toBe(30);
    creature.setFP(12);
    expect(creature.getFP()).toBe(12);
  });

  test('a save written by the old bug (MaxForcePoints 0, ForcePoints > 0) reads max from ForcePoints', () => {
    const creature = makeCreature({ base: 30, max: 0, current: 30 });
    expect(creature.getMaxFP()).toBe(30);
    expect(creature.getFP()).toBe(30);
  });

  test('UTC-spawned creature keeps its FP across save -> load', () => {
    const utc = new GFFObject();
    utc.RootNode.addField(new GFFField(GFFDataType.SHORT, 'ForcePoints')).setValue(30);
    utc.RootNode.addField(new GFFField(GFFDataType.SHORT, 'CurrentForce')).setValue(30);
    (GameState as any).FactionManager = { factions: new Map() };
    (GameState as any).AppearanceManager = { GetCreatureAppearanceById: (): any => undefined };
    const spawned = new ModuleCreature(utc);
    // initProperties logs unrelated asset gaps (no skills/appearance 2DA); the FP fields load before them.
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    spawned.initProperties();
    expect(spawned.getFP()).toBe(30);
    expect(spawned.getMaxFP()).toBe(30);

    const saved = spawned.save();
    expect(saved.RootNode.getFieldByLabel('MaxForcePoints').getValue()).toBe(30);

    const reloaded = new ModuleCreature(saved);
    reloaded.initProperties();
    expect(reloaded.getFP()).toBe(30);
    expect(reloaded.getMaxFP()).toBe(30);
  });
});

describe('cheat heal', () => {
  test('refills HP and FP for the controlled character and every party member, including UTC creatures', () => {
    const player = makeCreature({ base: 20, max: 20, current: 3 });
    const jedi = makeCreature({ base: 30, max: undefined, current: 5 });
    const bonus = makeCreature({ base: 20, max: 24, current: 0 });
    for(const creature of [player, jedi, bonus]){
      creature.maxHitPoints = 50;
      creature.hitPoints = 50;
      creature.currentHitPoints = 10;
    }
    (GameState as any).getCurrentPlayer = () => player;
    (GameState as any).PartyManager = { party: [player, jedi, bonus] };

    expect(CheatConsoleManager.heal()).toBe(true);

    expect([player.getFP(), jedi.getFP(), bonus.getFP()]).toEqual([20, 30, 24]);
    expect([player.getHP(), jedi.getHP(), bonus.getHP()]).toEqual([50, 50, 50]);
  });
});

describe('useTalent dispatch', () => {
  test('feat talents schedule an ATTACK_USE_FEAT round action and a combat action', () => {
    const caster = makeCreature();
    const target = makeCreature();
    const feat = Object.create(TalentFeat.prototype) as TalentFeat;
    feat.objectType = TalentObjectType.TalentObject | TalentObjectType.TalentFeat;
    feat.id = 11;
    caster.useTalent(feat, target);
    const scheduled = caster.combatRound.scheduledActionList;
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].actionType).toBe(CombatActionType.ATTACK_USE_FEAT);
    expect(scheduled[0].feat).toBe(feat);
    expect(scheduled[0].target).toBe(target);
    expect(caster.actionQueue.actionTypeExists(ActionType.ActionCombat)).toBe(true);
  });

  test('the Security skill talent queues an unlock action', () => {
    const caster = makeCreature();
    const target = makeCreature();
    const unlock = class { type = ActionType.ActionUnlockObject; groupId = 0xFFFF; parameters: any[] = []; setParameter(i: number, _t: number, v: any){ this.parameters[i] = v; } };
    (GameState as any).ActionFactory.ActionUnlockObject = unlock;
    const skill = new TalentSkill(6);
    caster.useTalent(skill, target);
    expect(caster.actionQueue).toHaveLength(1);
    expect(caster.actionQueue[0]).toBeInstanceOf(unlock);
    expect((caster.actionQueue[0] as any).parameters[0]).toBe(target.id);
    expect(caster.combatRound.scheduledActionList).toHaveLength(0);
  });

  test('useTalentOnObject tolerates an undefined target', () => {
    const caster = makeCreature();
    expect(() => new TalentSpell(SPELL_ID).useTalentOnObject(undefined, caster)).not.toThrow();
  });
});

describe('GetSpellSaveDC', () => {
  function caster(level: number, wis: number, spellcaster = true){
    const creature = makeCreature();
    creature.classes = [{ id: 3, level, spellcaster } as any];
    jest.spyOn(creature, 'getWIS').mockReturnValue(wis);
    return creature;
  }

  test('uses caster level and Wisdom modifier (5 + level + WIS mod)', () => {
    expect(GetSpellSaveDC.kotor.call({ caller: caster(8, 16) } as any)).toBe(5 + 8 + 3);
    expect(GetSpellSaveDC.kotor.call({ caller: caster(1, 10) } as any)).toBe(5 + 1 + 0);
    expect(GetSpellSaveDC.kotor.call({ caller: caster(12, 8) } as any)).toBe(5 + 12 - 1);
  });

  test('falls back to character level for casters without a spellcaster class', () => {
    expect(GetSpellSaveDC.kotor.call({ caller: caster(6, 14, false) } as any)).toBe(5 + 6 + 2);
  });
});

describe('action menu', () => {
  function buildMenu(){
    const state = GameState as any;
    state.ActionMenuManager = ActionMenuManager;
    state.Module = { ModuleArea: {
      ModuleObject, ModuleCreature,
      ModulePlaceable: class {}, ModuleDoor: class {}, ModuleTrigger: class {},
    } };
    installSpells({
      1: spellRow({ __rowlabel: '1', forcehostile: '1', forcefriendly: '****' }),
      2: spellRow({ __rowlabel: '2', forcehostile: '****', forcefriendly: '1' }),
    });
    const hostile = new TalentSpell(1);
    const friendly = new TalentSpell(2);
    const pc = makeCreature();
    const enemy = makeCreature();
    state.PartyManager = { party: [pc] };
    (pc as any).skills = [];
    jest.spyOn(pc, 'getSkillLevel').mockReturnValue(0);
    jest.spyOn(pc, 'getEquippedWeaponType').mockReturnValue(0);
    jest.spyOn(pc, 'getSpells').mockReturnValue([hostile, friendly]);
    jest.spyOn(enemy, 'isHostile').mockReturnValue(true);
    ActionMenuManager.InitActionMenuPanels();
    ActionMenuManager.SetPC(pc);
    ActionMenuManager.SetTarget(enemy);
    ActionMenuManager.UpdateMenuActions();
    return { pc, enemy, hostile, friendly };
  }

  test('hostile powers go to the target panel, friendly powers to the self panel', () => {
    const { hostile, friendly } = buildMenu();
    expect(ActionMenuManager.ActionPanels.targetPanels[1].actions.map((a: any) => a.talent)).toEqual([hostile]);
    expect(ActionMenuManager.ActionPanels.selfPanels[1].actions.map((a: any) => a.talent)).toEqual([friendly]);
  });

  test('picking a hostile power from the target menu casts it at the target', () => {
    const { pc, enemy } = buildMenu();
    ActionMenuManager.onTargetMenuAction(1);
    tick([pc, enemy]);
    expect(impactRuns).toHaveLength(1);
    expect(impactRuns[0].spellId).toBe(1);
    expect(impactRuns[0].spellTarget).toBe(enemy);
  });

  test('picking a friendly power from the self menu casts it on the player', () => {
    const { pc } = buildMenu();
    ActionMenuManager.onSelfMenuAction(1);
    tick([pc]);
    expect(impactRuns).toHaveLength(1);
    expect(impactRuns[0].spellId).toBe(2);
    expect(impactRuns[0].spellTarget).toBe(pc);
  });

  test('isHostile / isFriendly read **** as no', () => {
    const { hostile, friendly } = buildMenu();
    expect([hostile.isHostile(), hostile.isFriendly()]).toEqual([true, false]);
    expect([friendly.isHostile(), friendly.isFriendly()]).toEqual([false, true]);
  });
});

test('OBJECT_INVALID constant is what scripts pass for no target', () => {
  expect(GameState.ModuleObjectManager.GetObjectById(ModuleObjectConstant.OBJECT_INVALID)).toBeUndefined();
});
