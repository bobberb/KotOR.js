import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

// Browser/asset boundaries are stubbed; combat round, action queue, actions, talents,
// creature FP/DC math and the NWScript routine bodies all run for real.
jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/utility/GameFileSystem', () => ({ GameFileSystem: {} }));
jest.mock('@/loaders/ResourceLoader', () => ({ ResourceLoader: {} }));
jest.mock('@/loaders', () => ({ MDLLoader: { loader: { load: jest.fn() } }, ResourceLoader: {}, TextureLoader: {} }));
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

import { GameState } from '@/GameState';
import { ActionCastSpell } from '@/actions/ActionCastSpell';
import { ActionCombat } from '@/actions/ActionCombat';
import { ActionMoveToPoint } from '@/actions/ActionMoveToPoint';
import { TalentSpell } from '@/talents/TalentSpell';
import { TwoDAManager } from '@/managers/TwoDAManager';
import { ModuleCreature } from '@/module/ModuleCreature';
import { ModuleObject } from '@/module/ModuleObject';
import { SpellCastInstance } from '@/combat/SpellCastInstance';
import { ActionType } from '@/enums/actions/ActionType';
import { ActionCastSpellAtObject, GetSpellSaveDC } from '@/nwscript/builtins/miscLegacy';
import { GetSpellTargetObject, GetSpellId } from '@/nwscript/builtins/combat';
import { ActionUseTalentOnObject } from '@/nwscript/builtins/talents';

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

let objects: Map<number, ModuleObject>;
let spellInstances: SpellCastInstance[];
let impactRuns: { caller: any; spellTarget: any; spellId: number; saveDC: number }[];
let nextId = 1;

function installSpells(rows: Record<number, any>){
  TwoDAManager.datatables = new Map([['spells', { rows } as any]]);
}

function makeCreature(fp = { base: 20, max: 20, current: 20 }): ModuleCreature {
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
function tick(creatures: ModuleCreature[], seconds = 6, delta = 0.05){
  for(let t = 0; t < seconds; t += delta){
    for(const creature of creatures){
      creature.actionQueue.process(delta);
      creature.combatRound.update(delta);
    }
    for(const instance of spellInstances.slice()){
      instance.update(delta);
      if(instance.completed) spellInstances.splice(spellInstances.indexOf(instance), 1);
    }
  }
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
  state.ModuleObjectManager = { GetObjectById: (id: number) => objects.get(id) };
  state.module = { area: { id: 1, attachSpellInstance: (instance: SpellCastInstance) => spellInstances.push(instance) } };
  state.PartyManager = { party: [] };
  state.SWRuleSet = { ranges: [] };
  // The impact script runs the real NWScript routine bodies, the way the compiled script would.
  state.NWScript = {
    Load: jest.fn((name: string) => ({
      name,
      talent: undefined as any,
      run(caller: any){
        this.caller = caller;
        impactRuns.push({
          caller,
          spellTarget: GetSpellTargetObject.kotor.call(this),
          spellId: GetSpellId.kotor.call(this),
          saveDC: GetSpellSaveDC.kotor.call(this),
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
  test('player cast from the action menu path impacts once with spell target/id and spends FP', () => {
    const caster = makeCreature();
    const target = makeCreature();
    target.position.set(3, 0, 0);
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
    expect(caster.getFP()).toBe(20 - SPELL_COST);
    expect(target.combatData.lastSpellAttacker).toBe(caster);
    // The round finished and nothing is left hanging in the queue.
    expect(caster.combatRound.roundStarted).toBe(false);
    expect(caster.actionQueue.length).toBe(0);
    expect(spellInstances).toHaveLength(0);
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

  test('a spell row with no cast time still reaches impact', () => {
    installSpells({ [SPELL_ID]: spellRow({ casttime: '****', range: 'S' }) });
    const caster = makeCreature();
    const target = makeCreature();
    new TalentSpell(SPELL_ID).useTalentOnObject(target, caster);
    tick([caster, target]);
    expect(impactRuns).toHaveLength(1);
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

  test('free powers (forcepoints ****) cast without FP', () => {
    installSpells({ [SPELL_ID]: spellRow({ forcepoints: '****' }) });
    const caster = makeCreature({ base: 0, max: 0, current: 0 });
    const target = makeCreature();
    new TalentSpell(SPELL_ID).useTalentOnObject(target, caster);
    tick([caster, target]);
    expect(impactRuns).toHaveLength(1);
    expect(caster.getFP()).toBe(0);
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

  test('bCheat casts ignore FP and bInstantSpell skips conjuration', () => {
    const caster = makeCreature({ base: 0, max: 0, current: 0 });
    const target = makeCreature();
    ActionCastSpellAtObject.kotor.call({ caller: caster } as any, SPELL_ID, target, 0, 1, 0, 0, 1);
    tick([caster, target], 0.2);
    expect(impactRuns).toHaveLength(1);
    expect(caster.getFP()).toBe(0);
  });

  test('ActionUseTalentOnObject with a spell talent queues and resolves the cast', () => {
    const caster = makeCreature();
    const target = makeCreature();
    ActionUseTalentOnObject.kotor.call({ caller: caster } as any, new TalentSpell(SPELL_ID), target);
    tick([caster, target]);
    expect(impactRuns).toHaveLength(1);
    expect(impactRuns[0].spellTarget).toBe(target);
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
});

describe('GetSpellSaveDC', () => {
  function caster(level: number, wis: number){
    const creature = makeCreature();
    creature.classes = [{ id: 3, level, spellcaster: true } as any];
    jest.spyOn(creature, 'getWIS').mockReturnValue(wis);
    return creature;
  }

  test('uses caster level and Wisdom modifier (5 + level + WIS mod)', () => {
    expect(GetSpellSaveDC.kotor.call({ caller: caster(8, 16) } as any)).toBe(5 + 8 + 3);
    expect(GetSpellSaveDC.kotor.call({ caller: caster(1, 10) } as any)).toBe(5 + 1 + 0);
    expect(GetSpellSaveDC.kotor.call({ caller: caster(12, 8) } as any)).toBe(5 + 12 - 1);
  });
});

describe('action menu power filters', () => {
  test('hostile and friendly flags come from forcehostile/forcefriendly, **** meaning no', () => {
    installSpells({
      1: spellRow({ __rowlabel: '1', forcehostile: '1', forcefriendly: '****' }),
      2: spellRow({ __rowlabel: '2', forcehostile: '****', forcefriendly: '1' }),
    });
    const hostile = new TalentSpell(1);
    const friendly = new TalentSpell(2);
    expect([hostile.isHostile(), hostile.isFriendly()]).toEqual([true, false]);
    expect([friendly.isHostile(), friendly.isFriendly()]).toEqual([false, true]);
  });
});
