import { GameState } from "@/GameState";
import { GameEffectType } from "@/enums/effects/GameEffectType";
import { ModuleObjectType } from "@/enums/module/ModuleObjectType";
import { ModuleTriggerType } from "@/enums/module/ModuleTriggerType";
import { ModuleObjectScript } from "@/enums/module/ModuleObjectScript";
import { ExperienceType } from "@/enums/engine/ExperienceType";
import { SignalEventType } from "@/enums/events/SignalEventType";
import { SSFType } from "@/enums/resource/SSFType";
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
 * - A skill check is: skill ranks + key-ability modifier + skill effects +
 *   equipped-item skill properties + d20, succeeding when the total meets or
 *   beats the DC (SWSkillCheck.getSkillTotal is the single helper for this).
 * - Out of combat the d20 is "taken as 20" (no failure from a bad roll), in
 *   combat it is rolled. This preserves the engine's existing rule
 *   ("d20 rolls are auto 20's outside of combat", ModuleDoor/ModulePlaceable).
 * - Disarm / recover: failing by DISARM_TRIGGER_MARGIN or more sets the mine off.
 * - Recover: DC is the disarm DC + RECOVER_DC_BONUS.
 * - A mine of the creature's own faction is disarmed/recovered without a check
 *   (its owners know where and how it was set; it can never go off on them).
 * - A one-shot mine is spent once it goes off: it can no longer be detected,
 *   disarmed or recovered, and is removed from the area shortly after.
 * - Laying a mine: Demolitions check vs traps.2da `setdc`. On failure the mine
 *   is not set and the item is kept. The mine's DCs come from traps.2da
 *   (`detectdc`/`disarmdc` when present, else `setdc`, plus the *dcmod columns),
 *   not from the layer's skill.
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

export interface LayMineResult {
  outcome: 'set' | 'failed' | 'invalid';
  check?: SkillCheckResult;
  trigger?: ModuleTrigger;
}

/** 'key': a KeyRequired lock opened with the key (carried in `key`). */
export type UnlockOutcome = 'unlocked' | 'key' | 'not-locked' | 'key-required' | 'untrained' | 'failed' | 'invalid';

export interface UnlockResult {
  outcome: UnlockOutcome;
  check?: SkillCheckResult;
  key?: ModuleItem;
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

  /** Net ITEM_PROPERTY_SKILL / DECREASED_SKILL on equipped items (subtype = skill). */
  static skillItemBonus(creature: ModuleObject, skill: number): number {
    const equipment = (creature as any)?.equipment;
    if(!equipment || typeof equipment !== 'object') return 0;
    let bonus = 0;
    for(const item of Object.values<any>(equipment)){
      const properties: any[] = Array.isArray(item?.properties) ? item.properties : [];
      for(const property of properties){
        if(!property || (typeof property.isUseable === 'function' && !property.isUseable())) continue;
        const sign = property.is?.(ModuleItemProperty.Skill, skill) ? 1 :
          (property.is?.(ModuleItemProperty.DecreasedSkill, skill) ? -1 : 0);
        if(!sign) continue;
        let value = 0;
        try{ value = Number(property.getValue()) || 0; }catch(e){ value = 0; }
        bonus += sign * value;
      }
    }
    return bonus;
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
    return SWSkillCheck.skillRank(creature, skill) + abilityMod +
      SWSkillCheck.skillEffectBonus(creature, skill) + SWSkillCheck.skillItemBonus(creature, skill);
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
      if(!SWTrapRules.isLive(trap) || !trap.trapDetectable) continue;
      if(trap.isTrapDetectedBy(creature)) continue;
      if(creature.position.distanceTo(trap.position) > TRAP_DETECTION_RANGE) continue;
      const check = SWSkillCheck.check(creature, SkillType.AWARENESS, trap.trapDetectDC);
      if(!check.success) continue;
      trap.detectTrap(creature);
      detected.push(trap);
    }
    return detected;
  }

  /** Not destroyed and not a spent one-shot. */
  static isLive(trap: ModuleTrigger): boolean {
    return !!trap && !trap.destroyed && !trap.trapSpent;
  }

  static factionIdOf(object: ModuleObject): number {
    return (object as any)?.faction?.id ?? (object as any)?.factionId;
  }

  /** A mine owned by the creature's own faction (e.g. one the party laid). */
  static isOwnMine(creature: ModuleObject, trap: ModuleTrigger): boolean {
    const own = SWTrapRules.factionIdOf(creature);
    return own !== undefined && own === SWTrapRules.factionIdOf(trap);
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
    if(!creature || !SWTrapRules.isTrapTrigger(trap) || !SWTrapRules.isLive(trap)) return { outcome: 'invalid' };
    if(!trap.trapDisarmable) return { outcome: 'not-disarmable' };

    if(SWTrapRules.hasTrapKey(creature, trap) || SWTrapRules.isOwnMine(creature, trap)){
      const xp = SWTrapRules.isOwnMine(creature, trap) ? 0 : SWTrapRules.disarmXP(trap);
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
    if(!creature || !SWTrapRules.isTrapTrigger(trap) || !SWTrapRules.isLive(trap)) return { outcome: 'invalid' };
    if(!trap.trapDisarmable) return { outcome: 'not-disarmable' };

    if(SWTrapRules.isOwnMine(creature, trap)){
      // Picking up your own mine: no XP (it would be an XP farm), the item comes back.
      const item = SWTrapRules.createMineItem(trap);
      trap.disarmTrap(creature);
      if(item) creature.addItem(item);
      return { outcome: 'success', usedKey: true, item, xp: 0 };
    }

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
   * DCs of a traps.2da row: set DC (`setdc`), and detect/disarm DC = base +
   * modifier, where the base is `detectdc`/`disarmdc` when the table has them,
   * else `setdc`.
   */
  static rowDCs(row: any): { setDC: number, detectDC: number, disarmDC: number } {
    const has = (v: any) => v !== undefined && v !== null && v !== '' && v !== '****' && !isNaN(parseInt(v));
    const setDC = SWTrapRules.dcMod(row?.setdc);
    const detectBase = has(row?.detectdc) ? SWTrapRules.dcMod(row.detectdc) : setDC;
    const disarmBase = has(row?.disarmdc) ? SWTrapRules.dcMod(row.disarmdc) : setDC;
    return {
      setDC,
      detectDC: detectBase + SWTrapRules.dcMod(row?.detectdcmod),
      disarmDC: disarmBase + SWTrapRules.dcMod(row?.disarmdcmod),
    };
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
    // load() resolves trigger.faction from factionId.
    trigger.factionId = creator ? SWTrapRules.factionIdOf(creator) : 1;
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
   * A creature lays a mine (a traps.2da row) at a point: Demolitions vs the
   * row's set DC. On failure nothing is placed (the caller keeps the item).
   * The mine's DCs come from the row, not from the layer's skill.
   */
  static layMine(creature: ModuleObject, trapId: number, position: THREE.Vector3): LayMineResult {
    const row = SWTrapRules.trapRow(trapId);
    if(!row || !creature) return { outcome: 'invalid' };
    const dcs = SWTrapRules.rowDCs(row);
    const check = SWSkillCheck.check(creature, SkillType.DEMOLITIONS, dcs.setDC);
    if(!check.success) return { outcome: 'failed', check };
    const trigger = SWTrapRules.spawnMine(trapId, position, dcs.detectDC, dcs.disarmDC, creature, creature.area);
    if(!trigger) return { outcome: 'invalid', check };
    trigger.ownerDemolitions = check.modifier;
    return { outcome: 'set', check, trigger };
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
  /**
   * The key item for sTag as the creature holds it: the shared party inventory
   * for party members, the creature's own inventory otherwise.
   */
  static findKey(creature: ModuleObject, tag: string): ModuleItem | undefined {
    if(!creature || typeof tag !== 'string' || !tag.length) return undefined;
    if(SWTrapRules.isPartyMember(creature)){
      return GameState.InventoryManager?.getItemByTag?.(tag) || undefined;
    }
    const lower = tag.toLowerCase();
    const inventory: any[] = Array.isArray((creature as any).inventory) ? (creature as any).inventory : [];
    return inventory.find((item) => typeof item?.tag === 'string' && item.tag.toLowerCase() == lower);
  }

  /**
   * Open oLock: a KeyRequired lock only with its key, any other with a
   * Security check. Does not change the lock; callers unlock on 'unlocked'/'key'.
   */
  static attemptPick(creature: ModuleObject, lock: ModuleObject): UnlockResult {
    if(!creature || !lock) return { outcome: 'invalid' };
    if(!(lock as any).isLocked?.()) return { outcome: 'not-locked' };
    if((lock as any).keyRequired){
      const key = SWSecurityRules.findKey(creature, (lock as any).keyName);
      return key ? { outcome: 'key', key } : { outcome: 'key-required' };
    }
    if(!SWSkillCheck.canUseSkill(creature, SkillType.SECURITY)) return { outcome: 'untrained' };
    const check = SWSkillCheck.check(creature, SkillType.SECURITY, (lock as any).openLockDC);
    return { outcome: check.success ? 'unlocked' : 'failed', check };
  }

  /**
   * One attempt by opener to unlock lock (door or placeable), shared by both:
   * unlocks on success (removing an AutoRemoveKey key), otherwise signals
   * OnFailToOpen exactly once. Returns the result; the caller opens on success.
   */
  static unlockAttempt(lock: any, opener: ModuleObject): UnlockResult {
    const result = SWSecurityRules.attemptPick(opener, lock);
    lock.lastUnlockAttempt = result;
    const isCreature = BitWise.InstanceOf(opener?.objectType, ModuleObjectType.ModuleCreature);
    if(result.outcome == 'unlocked' || result.outcome == 'key'){
      lock.unlock(opener);
      if(result.outcome == 'key' && lock.autoRemoveKey && result.key){
        opener.removeItem(result.key);
      }
      if(isCreature) (opener as any).playSoundSet(SSFType.UNLOCK_SUCCESS);
      return result;
    }
    if(isCreature) (opener as any).playSoundSet(SSFType.UNLOCK_FAIL);
    SWSecurityRules.signalFailToOpen(lock, opener);
    return result;
  }

  static signalFailToOpen(lock: ModuleObject, opener: ModuleObject){
    const event = new GameState.GameEventFactory.EventSignalEvent();
    event.setCaller(opener);
    event.setObject(lock);
    event.setDay(GameState.module.timeManager.pauseDay);
    event.setTime(GameState.module.timeManager.pauseTime);
    event.eventType = SignalEventType.OnFailToOpen;
    GameState.module.addEvent(event);
  }
}
