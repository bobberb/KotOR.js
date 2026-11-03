import { Action } from "@/actions/Action";
import { SpellCastInstance } from "@/combat/SpellCastInstance";
import { CombatRoundAction } from "@/combat/CombatRoundAction";
import { CombatActionType } from "@/enums/combat/CombatActionType";
import { ModuleObjectType } from "@/enums/module/ModuleObjectType";
import { ActionStatus } from "@/enums/actions/ActionStatus";
import { ActionType } from "@/enums/actions/ActionType";
import { ModuleCreatureAnimState } from "@/enums/module/ModuleCreatureAnimState";
import { ModuleObjectConstant } from "@/enums/module/ModuleObjectConstant";
import { GameState } from "@/GameState";
import { enqueueMoveToPoint } from "@/actions/helpers/enqueueMoveToPoint";
import type { TalentSpell } from "@/talents/TalentSpell";
import { BitWise } from "@/utility/BitWise";
import { Utility } from "@/utility/Utility";
import type { ModuleObject } from "@/module/ModuleObject";
import type { ModuleCreature } from "@/module/ModuleCreature";
import type { ModuleItem } from "@/module/ModuleItem";
import { ActionParameterType } from "@/enums/actions/ActionParameterType";
import { ModuleItemCostTable } from "@/enums/module/ModuleItemCostTable";
import * as THREE from "three";

/**
 * ActionCastSpell class.
 *
 * KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
 *
 * @file ActionCastSpell.ts
 * @author KobaltBlu <https://github.com/KobaltBlu>
 * @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
 */
export class ActionCastSpell extends Action {

  spell: any = {}
  /** bCheat from ActionCastSpellAtObject: caster need not be able to cast it, so no force point gate or cost. Runtime-only, not saved. */
  cheat: boolean = false;
  /** bInstantSpell from ActionCastSpellAtObject: skip conjure and cast time. Runtime-only, not saved. */
  instant: boolean = false;
  /** ActionCastFakeSpellAt*: conjure/cast animation and visuals only; no force point gate or cost, no impact script. Runtime-only, not saved. */
  fake: boolean = false;
  /** Consecutive walks toward the cast point that ended no closer than they started. */
  stalledApproaches: number = 0;
  /** 2D distance to the cast point when the last walk was queued. */
  approachStartDistance: number | undefined;
  static MAX_STALLED_APPROACHES = 3;
  static APPROACH_PROGRESS_EPSILON = 0.25;
  /** Range for walks toward an object; arrival is decided by the walk's stopWhen (a move restored from a save lacks it and walks close). */
  static OBJECT_MOVE_RANGE = 1.0;

  constructor( actionId: number = -1, groupId: number = -1 ){
    super(actionId, groupId);
    this.type = ActionType.ActionCastSpell;

    //PARAMS
    // 0 - int: nSpellId
    // 1 - int: Unknown: -1 if cheat enabled
    // 2 - int: nDomainLevel
    // 3 - int: Unknown: Always 0?
    // 4 - int: Unknown: Always 0?
    // 5 - dword: target object id
    // 6 - float: target x
    // 7 - float: target y
    // 8 - float: target z
    // 9 - int: nProjectilePath
    // 10 - int: Unknown: Always -1?
    // 11 - int: Unknown: -1 if cheat enabled

  }

  update(delta: number = 0): ActionStatus {
    this.target = this.getParameter<ModuleObject>(5);
    // An object target that no longer resolves (destroyed since queueing) fails the cast instead of becoming a location cast.
    if(!this.target && this.hasTargetObjectId()) return ActionStatus.FAILED;
    const spellId = this.getParameter<number>(0);
    if(!(this.spell instanceof GameState.TalentSpell) || this.spell.id !== spellId){
      this.spell = new GameState.TalentSpell(spellId);
    }
    const spell: TalentSpell = this.spell;
    if(!spell) return ActionStatus.FAILED;

    // Placeables/triggers cannot move into range and have no combat round driving them, so their casts resolve directly.
    if(!BitWise.InstanceOfObject(this.owner, ModuleObjectType.ModuleCreature)){
      this.startSpellInstance(spell);
      return ActionStatus.COMPLETE;
    }

    const combatRound = this.owner.combatRound;
    if(!combatRound) return ActionStatus.FAILED;
    // Wait out the current cast's round before walking: a queued cast must not move the caster mid-conjure.
    if(combatRound.roundPaused) return ActionStatus.IN_PROGRESS;

    const target = this.target;
    const castPoint = target
      ? target.position
      : new THREE.Vector3(this.getParameter<number>(6) || 0, this.getParameter<number>(7) || 0, this.getParameter<number>(8) || 0);
    if(target != this.owner && !spell.isPointInRange(this.owner, castPoint)){
      // Only walks that ended no closer than they started count against the cast (unreachable point, blocked
      // walkmesh); chasing a target that keeps moving away is fine as long as each walk gains ground.
      const distance = Utility.Distance2D(this.owner.position, castPoint);
      if(this.approachStartDistance !== undefined){
        this.stalledApproaches = distance < this.approachStartDistance - ActionCastSpell.APPROACH_PROGRESS_EPSILON
          ? 0
          : this.stalledApproaches + 1;
      }
      if(this.stalledApproaches >= ActionCastSpell.MAX_STALLED_APPROACHES) return this.refuse(spell);
      this.approachStartDistance = distance;
      const approachRange = spell.getApproachRange();
      const move = enqueueMoveToPoint(this.owner, {
        x: castPoint.x,
        y: castPoint.y,
        z: castPoint.z,
        area: GameState.module.area.id,
        target: target ? target.id : ModuleObjectConstant.OBJECT_INVALID,
        run: true,
        // A move toward an object would otherwise stop near a stand-off point computed from where the target
        // was, which a fleeing target has already left; the live stopWhen below is the real arrival test.
        range: target ? ActionCastSpell.OBJECT_MOVE_RANGE : approachRange,
        timeout: 30.0,
        groupId: this.groupId,
      });
      // Stop the walk the moment the (possibly moving) target is within approach range.
      move.stopWhen = () => spell.isPointInRange(this.owner, target ? target.position : castPoint, approachRange);
      return ActionStatus.IN_PROGRESS;
    }

    // Menu/talent casts arrive via ActionCombat with their round action (and the talent it carries) already set.
    const queued = combatRound.action;
    const reuseQueued = !!queued && queued.actionType == CombatActionType.CAST_SPELL && queued.spellId == spell.id;
    const castSpell: TalentSpell = (reuseQueued && queued.spell) || spell;
    // Item-granted powers (armbands) are paid for by the item, not the caster's force points. Param 4 carries the
    // item id so the source survives a save/load of the queued action (the round action is runtime-only).
    const itemRequested = !!castSpell.item || this.hasSourceItemId();
    const item = (castSpell.item || this.getSourceItem()) as ModuleItem | undefined;
    if(item && !castSpell.item) castSpell.setItem(item);
    const paysForcePoints = !this.cheat && !this.fake && !itemRequested;
    const usesItemCharge = !this.cheat && !this.fake && itemRequested;
    if(
      (paysForcePoints && !ActionCastSpell.CanAffordSpell(this.owner, castSpell)) ||
      // The power comes from the item: refuse when it is gone, no longer equipped by the caster, or out of charges.
      (usesItemCharge && !(ActionCastSpell.IsItemEquippedBy(item, this.owner) && ActionCastSpell.ItemHasCharge(item, spell.id)))
    ){
      return this.refuse(spell);
    }

    this.owner.force = 0;
    this.owner.speed = 0;

    // Script-initiated casts (ActionCastSpellAtObject) bypass ActionCombat, so no round action exists yet.
    let combatAction = queued;
    if(!reuseQueued){
      combatAction = new CombatRoundAction(this.owner);
      combatAction.actionType = CombatActionType.CAST_SPELL;
      combatAction.target = this.target;
      combatAction.setSpell(castSpell);
      combatAction.isUserAction = this.isUserAction;
      combatRound.action = combatAction;
    }
    combatAction.fake = this.fake;
    combatAction.animation = ModuleCreatureAnimState.CASTOUT1;
    combatAction.animationName = castSpell.getConjureAnimation();

    combatRound.beginCombatRound();
    combatRound.pauseRound(this.owner, combatRound.roundLength);

    if(paysForcePoints){
      this.owner.subtractFP(ActionCastSpell.GetSpellForceCost(castSpell));
    }
    if(usesItemCharge){
      ActionCastSpell.ConsumeItemCharge(item, spell.id);
    }

    if(!this.fake){
      // Cleared until the power actually lands (SpellCastInstance.applyImpact sets it).
      this.owner.combatData.lastForcePowerSuccess = false;
      this.owner.combatData.lastSpellTarget = this.target;
      if(this.target?.combatData) this.target.combatData.lastSpellAttacker = this.owner;
    }

    this.startSpellInstance(castSpell);
    return ActionStatus.COMPLETE;
  }

  private startSpellInstance(spell: TalentSpell){
    const spellCastInstance = new SpellCastInstance(this.owner, this.target, spell);
    spellCastInstance.fake = this.fake;
    if(this.instant){
      spellCastInstance.conjureTime = 0;
      spellCastInstance.castTime = 0;
    }
    if(this.target){
      spellCastInstance.targetLocation.copy(this.target.position);
    }else{
      spellCastInstance.targetLocation.set(
        this.getParameter<number>(6) || 0,
        this.getParameter<number>(7) || 0,
        this.getParameter<number>(8) || 0,
      );
    }
    const area = this.owner.area || GameState.module?.area;
    area?.attachSpellInstance(spellCastInstance);
    spellCastInstance.init();
    return spellCastInstance;
  }

  private hasTargetObjectId(): boolean {
    const id = this.parameters[5]?.value;
    // Location casts store -1, which a GFF DWORD round trip turns into 0xFFFFFFFF.
    return typeof id === 'number' && id > 0 && id !== ModuleObjectConstant.OBJECT_INVALID && id !== 0xFFFFFFFF;
  }

  static GetSpellForceCost(spell: TalentSpell): number {
    return spell ? spell.getForcePointCost() : 0;
  }

  /**
   * The cast cannot happen. The creature still loses its round so the end-of-round AI hook fires and it can
   * choose something else; that round is empty, so a different pending round action is neither started nor
   * reported (GetLastForcePowerUsed) by this refusal.
   */
  private refuse(spell: TalentSpell): ActionStatus {
    const combatRound = this.owner.combatRound;
    if(combatRound){
      const pending = combatRound.action;
      if(pending && pending.actionType == CombatActionType.CAST_SPELL && pending.spellId == spell.id){
        combatRound.action = undefined;
      }
      if(!combatRound.action && !combatRound.roundStarted) combatRound.beginCombatRound();
    }
    return ActionStatus.FAILED;
  }

  private hasSourceItemId(): boolean {
    const param = this.parameters[4];
    if(param?.type !== ActionParameterType.DWORD) return false;
    const id = param.value;
    return typeof id === 'number' && id > 0 && id !== ModuleObjectConstant.OBJECT_INVALID && id !== 0xFFFFFFFF;
  }

  private getSourceItem(): ModuleItem | undefined {
    if(!this.hasSourceItemId()) return undefined;
    const item = this.getParameter<ModuleItem>(4);
    return BitWise.InstanceOfObject(item, ModuleObjectType.ModuleItem) ? item : undefined;
  }

  /** Item powers come from equipped items (armbands); a destroyed, sold or unequipped item grants nothing. */
  static IsItemEquippedBy(item: ModuleItem, owner: ModuleObject): boolean {
    if(!item || item.destroyed) return false;
    const equipment: Record<string, any> = (owner as any)?.equipment || {};
    return Object.values(equipment).includes(item);
  }

  /**
   * Charges spent per use, from the CastSpell property's iprp_chargecost CostValue. Rows follow the NWN
   * layout (KotOR inherits it; unverified against KotOR data): 0 single use, 1-6 = 5..0 charges/use,
   * 7-11 = 1..5 uses/day, 12 unlimited. Without a SpellUse cost the default is 1 charge per use.
   * Uses/day are not limited: there is no rest cycle to restore them yet.
   */
  static ChargesPerUse(item: ModuleItem, spellId: number): number | 'single' {
    const property = item?.getCastSpellProperty?.(spellId);
    if(!property || Number(property.costTable) !== ModuleItemCostTable.SpellUse) return 1;
    const row = Number(property.costValue);
    if(row === 0) return 'single';
    if(row >= 1 && row <= 6) return 6 - row;
    return 0;
  }

  /**
   * Charge-based items (MaxCharges > 0) need enough charges for one use. Charges belong to the item object,
   * so a stack shares one counter. Single-use powers mark the item spent instead of destroying it.
   */
  static IsChargeItem(item: ModuleItem): boolean {
    return Number(item?.maxCharges) > 0;
  }

  static ItemHasCharge(item: ModuleItem, spellId: number): boolean {
    if(!ActionCastSpell.IsChargeItem(item)) return true;
    const perUse = ActionCastSpell.ChargesPerUse(item, spellId);
    return Number(item.charges) >= (perUse === 'single' ? 1 : perUse);
  }

  static ConsumeItemCharge(item: ModuleItem, spellId: number){
    const perUse = ActionCastSpell.ChargesPerUse(item, spellId);
    if(perUse === 'single'){
      item.maxCharges = Math.max(1, Number(item.maxCharges) || 0);
      item.charges = 0;
    }else if(ActionCastSpell.IsChargeItem(item)){
      item.charges = Math.max(0, (Number(item.charges) || 0) - perUse);
    }
  }

  static CanAffordSpell(caster: ModuleObject, spell: TalentSpell): boolean {
    const cost = ActionCastSpell.GetSpellForceCost(spell);
    if(cost <= 0) return true;
    if(!BitWise.InstanceOfObject(caster, ModuleObjectType.ModuleCreature)) return true;
    return (caster as ModuleCreature).getFP() >= cost;
  }

}
