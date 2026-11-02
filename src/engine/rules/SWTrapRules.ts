import { GameState } from "@/GameState";
import { GameEffectType } from "@/enums/effects/GameEffectType";
import { ModuleObjectType } from "@/enums/module/ModuleObjectType";
import { ModuleTriggerType } from "@/enums/module/ModuleTriggerType";
import { ModuleObjectScript } from "@/enums/module/ModuleObjectScript";
import { ExperienceType } from "@/enums/engine/ExperienceType";
import { SkillType } from "@/enums/nwscript/SkillType";
import { ModuleItemProperty } from "@/enums/module/ModuleItemProperty";
import { GFFObject } from "@/resource/GFFObject";
import { ResourceTypes } from "@/resource/ResourceTypes";
import { ResourceLoader } from "@/loaders/ResourceLoader";
import { BitWise } from "@/utility/BitWise";
import { Dice } from "@/utility/Dice";
import type { ModuleObject } from "@/module/ModuleObject";
import type { ModuleTrigger } from "@/module/ModuleTrigger";
import type { ModuleItem } from "@/module/ModuleItem";
import * as THREE from "three";

/**
 * Skill checks for traps (mines) and locks, following the KotOR d20 rules.
 *
 * Rules applied here (sources and what is unverified are listed in the
 * commit/PR and in tests/traps-security.test.ts):
 *
 * - A skill check is: skill ranks + key-ability modifier + skill effects + d20,
 *   succeeding when the total meets or beats the DC.
 * - Out of combat the d20 is "taken as 20" (no failure from a bad roll), in
 *   combat it is rolled. This preserves the engine's existing rule
 *   ("d20 rolls are auto 20's outside of combat", ModuleDoor/ModulePlaceable).
 * - Disarm / recover: failing by DISARM_TRIGGER_MARGIN or more sets the mine off.
 * - Recover: DC is the disarm DC + RECOVER_DC_BONUS.
 * - Passive detection: party members only, within TRAP_DETECTION_RANGE metres,
 *   Awareness check against TrapDetectDC, only for TrapDetectable traps.
 * - Locks: Security check against OpenLockDC; KeyRequired locks cannot be picked;
 *   Security cannot be used untrained.
 */

/** Metres within which a party member passively spots a detectable mine. */
export const TRAP_DETECTION_RANGE = 10;
/** Failing a disarm/recover check by this much or more sets the mine off (d20 Disable Device). */
export const DISARM_TRIGGER_MARGIN = 5;
/** Extra DC for recovering a mine intact versus disarming it. */
export const RECOVER_DC_BONUS = 5;
/** Half-width (metres) of the square trigger created for a laid mine; matches ModuleObject.addTrap. */
export const MINE_TRIGGER_HALF_WIDTH = 2;

/** Key ability per skill when skills.2da is not loaded (KotOR skills.2da `keyability`). */
const DEFAULT_KEY_ABILITY: Record<number, string> = {
  [SkillType.COMPUTER_USE]: 'INT',
  [SkillType.DEMOLITIONS]: 'INT',
  [SkillType.STEALTH]: 'DEX',
  [SkillType.AWARENESS]: 'WIS',
  [SkillType.PERSUADE]: 'CHA',
  [SkillType.REPAIR]: 'INT',
  [SkillType.SECURITY]: 'INT',
  [SkillType.TREAT_INJURY]: 'WIS',
};

export interface SkillCheckResult {
  skill: number;
  /** Skill total without the die. */
  modifier: number;
  roll: number;
  total: number;
  dc: number;
  success: boolean;
  /** dc - total; positive when the check failed. */
  failedBy: number;
}

export type TrapAttemptOutcome = 'success' | 'failed' | 'triggered' | 'not-disarmable' | 'invalid';

export interface TrapAttemptResult {
  outcome: TrapAttemptOutcome;
  check?: SkillCheckResult;
  usedKey?: boolean;
  item?: ModuleItem;
  xp?: number;
}

export type UnlockOutcome = 'unlocked' | 'not-locked' | 'key-required' | 'untrained' | 'failed' | 'invalid';

export interface UnlockResult {
  outcome: UnlockOutcome;
  check?: SkillCheckResult;
}

export class SWSkillCheck {

  static abilityModifier(score: number): number {
    if(typeof score !== 'number' || isNaN(score)) return 0;
    return Math.floor((score - 10) / 2);
  }

  static keyAbility(skill: number): string {
    const fromTable = GameState.SWRuleSet?.skills?.[skill]?.keyAbility;
    if(typeof fromTable === 'string' && fromTable.length){
      return fromTable.toUpperCase();
    }
    return DEFAULT_KEY_ABILITY[skill] || '';
  }

  static abilityScore(creature: ModuleObject, ability: string): number {
    const getter = (creature as any)?.['get' + ability];
    if(typeof getter !== 'function') return 10;
    const score = getter.call(creature);
    return typeof score === 'number' && !isNaN(score) ? score : 10;
  }

  /** Base ranks; read directly so an ability-inclusive getSkillLevel can't double count. */
  static skillRank(creature: ModuleObject, skill: number): number {
    const rank = (creature as any)?.skills?.[skill]?.rank;
    if(typeof rank === 'number' && !isNaN(rank)) return rank;
    return 0;
  }

  static canUseSkill(creature: ModuleObject, skill: number): boolean {
    if(SWSkillCheck.skillRank(creature, skill) > 0) return true;
    return !!(creature as any)?.skills?.[skill]?.untrained;
  }

  /** Net EffectSkillIncrease/Decrease for a skill (security tunnelers apply one). */
  static skillEffectBonus(creature: ModuleObject, skill: number): number {
    const effects: any[] = Array.isArray((creature as any)?.effects) ? (creature as any).effects : [];
    let bonus = 0;
    for(const effect of effects){
      if(!effect) continue;
      const effectSkill = effect.getInt?.(0);
      // NWScript SKILL_ALL_SKILLS is 255.
      if(effectSkill !== skill && effectSkill !== 255) continue;
      const amount = Number(effect.getInt?.(1)) || 0;
      if(effect.type === GameEffectType.EffectSkillIncrease) bonus += amount;
      else if(effect.type === GameEffectType.EffectSkillDecrease) bonus -= amount;
    }
    return bonus;
  }

  static getSkillTotal(creature: ModuleObject, skill: number): number {
    const ability = SWSkillCheck.keyAbility(skill);
    const abilityMod = ability ? SWSkillCheck.abilityModifier(SWSkillCheck.abilityScore(creature, ability)) : 0;
    return SWSkillCheck.skillRank(creature, skill) + abilityMod + SWSkillCheck.skillEffectBonus(creature, skill);
  }

  static isInCombat(creature: ModuleObject): boolean {
    return !!(creature as any)?.combatData?.combatState;
  }

  static rollD20(creature: ModuleObject): number {
    if(!SWSkillCheck.isInCombat(creature)) return 20;
    return Dice.rollD20(1);
  }

  static check(creature: ModuleObject, skill: number, dc: number): SkillCheckResult {
    const modifier = SWSkillCheck.getSkillTotal(creature, skill);
    const roll = SWSkillCheck.rollD20(creature);
    const total = modifier + roll;
    dc = Number(dc) || 0;
    return { skill, modifier, roll, total, dc, success: total >= dc, failedBy: dc - total };
  }
}

export class SWTrapRules {

  static isTrapTrigger(object: ModuleObject): object is ModuleTrigger {
    return BitWise.InstanceOfObject(object, ModuleObjectType.ModuleTrigger) && (object as any).type == ModuleTriggerType.TRAP;
  }

  static isPartyMember(object: ModuleObject): boolean {
    if(!object) return false;
    if(typeof (object as any).isPartyMember === 'function' && (object as any).isPartyMember()) return true;
    return (GameState.PartyManager?.party || []).indexOf(object as any) >= 0;
  }

  /**
   * Periodic Awareness checks for a party member against every undetected,
   * detectable mine in range. Returns the traps detected this pass.
   */
  static passiveDetect(creature: ModuleObject, candidates: ModuleObject[] = []): ModuleTrigger[] {
    const detected: ModuleTrigger[] = [];
    if(!creature || !SWTrapRules.isPartyMember(creature)) return detected;
    if(typeof (creature as any).isDead === 'function' && (creature as any).isDead()) return detected;

    for(const candidate of candidates){
      if(!SWTrapRules.isTrapTrigger(candidate)) continue;
      const trap = candidate as ModuleTrigger;
      if(trap.destroyed || !trap.trapDetectable) continue;
      if(trap.isTrapDetectedBy(creature)) continue;
      if(creature.position.distanceTo(trap.position) > TRAP_DETECTION_RANGE) continue;
      const check = SWSkillCheck.check(creature, SkillType.AWARENESS, trap.trapDetectDC);
      if(!check.success) continue;
      trap.detectTrap(creature);
      detected.push(trap);
    }
    return detected;
  }

  /** XP for neutralising a mine. Not confirmed against the retail engine; scales with difficulty. */
  static disarmXP(trap: ModuleObject): number {
    return Math.max(0, Number(trap?.trapDisarmDC) || 0);
  }

  static awardXP(creature: ModuleObject, xp: number){
    if(!(xp > 0) || !creature) return;
    if(SWTrapRules.isPartyMember(creature) && GameState.PartyManager?.GiveXP){
      GameState.PartyManager.GiveXP(xp);
    }else if(typeof (creature as any).addXP === 'function'){
      (creature as any).addXP(xp, ExperienceType.PLOT);
    }
  }

  static hasTrapKey(creature: ModuleObject, trap: ModuleObject): boolean {
    const keyTag = (trap as any)?.keyName;
    if(typeof keyTag !== 'string' || !keyTag.length) return false;
    return typeof (creature as any)?.hasItemByTag === 'function' && !!(creature as any).hasItemByTag(keyTag);
  }

  static attemptDisarm(creature: ModuleObject, trap: ModuleTrigger): TrapAttemptResult {
    if(!creature || !SWTrapRules.isTrapTrigger(trap) || trap.destroyed) return { outcome: 'invalid' };
    if(!trap.trapDisarmable) return { outcome: 'not-disarmable' };

    if(SWTrapRules.hasTrapKey(creature, trap)){
      const xp = SWTrapRules.disarmXP(trap);
      trap.disarmTrap(creature);
      SWTrapRules.awardXP(creature, xp);
      return { outcome: 'success', usedKey: true, xp };
    }

    const check = SWSkillCheck.check(creature, SkillType.DEMOLITIONS, trap.trapDisarmDC);
    if(check.success){
      const xp = SWTrapRules.disarmXP(trap);
      trap.disarmTrap(creature);
      SWTrapRules.awardXP(creature, xp);
      return { outcome: 'success', check, xp };
    }
    if(check.failedBy >= DISARM_TRIGGER_MARGIN){
      trap.fireTrap(creature);
      return { outcome: 'triggered', check };
    }
    return { outcome: 'failed', check };
  }

  /** The mine's item: traps.2da `resref` (a .uti). */
  static createMineItem(trap: ModuleTrigger): ModuleItem | undefined {
    const resref = trap.trapResRef;
    if(!resref || resref == '****') return undefined;
    const buffer = ResourceLoader.loadCachedResource(ResourceTypes['uti'], resref);
    if(!buffer) return undefined;
    const item = new GameState.Module.ModuleArea.ModuleItem(new GFFObject(buffer));
    item.initProperties?.();
    return item;
  }

  static attemptRecover(creature: ModuleObject, trap: ModuleTrigger): TrapAttemptResult {
    if(!creature || !SWTrapRules.isTrapTrigger(trap) || trap.destroyed) return { outcome: 'invalid' };
    if(!trap.trapDisarmable) return { outcome: 'not-disarmable' };

    const check = SWSkillCheck.check(creature, SkillType.DEMOLITIONS, (Number(trap.trapDisarmDC) || 0) + RECOVER_DC_BONUS);
    if(check.success){
      const item = SWTrapRules.createMineItem(trap);
      const xp = SWTrapRules.disarmXP(trap);
      trap.disarmTrap(creature);
      if(item) creature.addItem(item);
      SWTrapRules.awardXP(creature, xp);
      return { outcome: 'success', check, item, xp };
    }
    if(check.failedBy >= DISARM_TRIGGER_MARGIN){
      trap.fireTrap(creature);
      return { outcome: 'triggered', check };
    }
    return { outcome: 'failed', check };
  }

  static trapRow(trapId: number): any {
    return GameState.TwoDAManager?.datatables?.get('traps')?.rows?.[trapId];
  }

  static dcMod(value: any): number {
    const n = parseInt(value);
    return isNaN(n) ? 0 : n;
  }

  /**
   * Creates a mine trigger at a point. Owned by the creator's faction, so it
   * goes off only for creatures hostile to that faction; the creator's faction
   * knows where it is.
   */
  static spawnMine(trapId: number, position: THREE.Vector3, detectDC: number, disarmDC: number, creator?: ModuleObject, area?: any): ModuleTrigger | undefined {
    const row = SWTrapRules.trapRow(trapId);
    if(!row) return undefined;

    const trigger: ModuleTrigger = new GameState.Module.ModuleArea.ModuleTrigger();
    trigger.type = ModuleTriggerType.TRAP;
    trigger.trapType = trapId;
    trigger.trapFlag = true;
    trigger.trapDetectable = true;
    trigger.trapDisarmable = true;
    trigger.trapOneShot = true;
    trigger.trapDetectDC = Math.max(0, Math.min(255, detectDC | 0));
    trigger.trapDisarmDC = Math.max(0, Math.min(255, disarmDC | 0));
    trigger.position.copy(position);
    // No creator (a script-spawned mine): STANDARD_FACTION_HOSTILE_1, so it threatens the party.
    const factionId = creator ? (creator.faction?.id ?? creator.factionId) : 1;
    const applyFaction = () => {
      trigger.factionId = factionId;
      trigger.faction = creator?.faction ?? GameState.FactionManager?.factions?.get(factionId);
    };
    applyFaction();
    if(creator){
      trigger.setByPlayerParty = SWTrapRules.isPartyMember(creator) ? 1 : 0;
      trigger.trapCreatorId = creator.id;
    }

    const h = MINE_TRIGGER_HALF_WIDTH;
    trigger.vertices = [
      new THREE.Vector3(-h,  h, 0),
      new THREE.Vector3(-h, -h, 0),
      new THREE.Vector3( h, -h, 0),
      new THREE.Vector3( h,  h, 0),
    ];

    trigger.load();
    // load() re-reads the empty template and resets the faction object.
    applyFaction();

    if(row.trapscript && row.trapscript != '****' && GameState.NWScript?.Load){
      const nwscript = GameState.NWScript.Load(row.trapscript);
      if(nwscript){
        nwscript.caller = trigger;
        trigger.scripts[ModuleObjectScript.TriggerOnTrapTriggered] = nwscript;
      }
    }

    if(creator){
      trigger.detectTrap(creator);
    }

    const targetArea = area ?? creator?.area ?? GameState.module?.area;
    if(targetArea){
      if(typeof targetArea.attachObject === 'function') targetArea.attachObject(trigger);
      else if(Array.isArray(targetArea.triggers)) targetArea.triggers.push(trigger);
    }
    return trigger;
  }

  /**
   * A creature lays a mine (a traps.2da row) at a point. DCs follow the
   * existing addTrap formula: 2DA modifier + setter's Demolitions + d20.
   */
  static layMine(creature: ModuleObject, trapId: number, position: THREE.Vector3): ModuleTrigger | undefined {
    const row = SWTrapRules.trapRow(trapId);
    if(!row || !creature) return undefined;
    const demolitions = SWSkillCheck.getSkillTotal(creature, SkillType.DEMOLITIONS);
    const roll = SWSkillCheck.rollD20(creature);
    const detectDC = SWTrapRules.dcMod(row.detectdcmod) + demolitions + roll;
    const disarmDC = SWTrapRules.dcMod(row.disarmdcmod) + demolitions + roll;
    const trigger = SWTrapRules.spawnMine(trapId, position, detectDC, disarmDC, creature, creature.area);
    if(trigger) trigger.ownerDemolitions = demolitions;
    return trigger;
  }

  /** Trap id carried by a mine item (ITEM_PROPERTY_TRAP subtype), or -1. */
  static mineTrapId(item: ModuleItem): number {
    const properties: any[] = (item as any)?.properties || [];
    for(const property of properties){
      if(property?.is?.(ModuleItemProperty.Trap)) return property.subType;
    }
    return -1;
  }
}

export class SWSecurityRules {
  /** Security check to pick oLock. Does not change the lock; callers unlock on 'unlocked'. */
  static attemptPick(creature: ModuleObject, lock: ModuleObject): UnlockResult {
    if(!creature || !lock) return { outcome: 'invalid' };
    if(!(lock as any).isLocked?.()) return { outcome: 'not-locked' };
    if((lock as any).keyRequired) return { outcome: 'key-required' };
    if(!SWSkillCheck.canUseSkill(creature, SkillType.SECURITY)) return { outcome: 'untrained' };
    const check = SWSkillCheck.check(creature, SkillType.SECURITY, (lock as any).openLockDC);
    return { outcome: check.success ? 'unlocked' : 'failed', check };
  }
}
