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
import type { ModuleObject } from "@/module/ModuleObject";
import type { ModuleCreature } from "@/module/ModuleCreature";

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

    if(this.target && !spell.inRange(this.target, this.owner)){
      enqueueMoveToPoint(this.owner, {
        x: this.target.position.x,
        y: this.target.position.y,
        z: this.target.position.z,
        area: GameState.module.area.id,
        target: this.target.id,
        run: true,
        range: spell.getCastRange(),
        timeout: 30.0,
        groupId: this.groupId,
      });
      return ActionStatus.IN_PROGRESS;
    }

    const combatRound = this.owner.combatRound;
    if(!combatRound) return ActionStatus.FAILED;
    if(combatRound.roundPaused) return ActionStatus.IN_PROGRESS;

    // Menu/talent casts arrive via ActionCombat with their round action (and the talent it carries) already set.
    const queued = combatRound.action;
    const reuseQueued = !!queued && queued.actionType == CombatActionType.CAST_SPELL && queued.spellId == spell.id;
    // Item-granted powers (armbands) are paid for by the item, not the caster's force points.
    const castSpell: TalentSpell = (reuseQueued && queued.spell) || spell;
    const paysForcePoints = !this.cheat && !this.fake && !castSpell.item;
    if(paysForcePoints && !ActionCastSpell.CanAffordSpell(this.owner, castSpell)){
      if(reuseQueued) combatRound.action = undefined;
      return ActionStatus.FAILED;
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

    if(!this.fake){
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

  /**
   * Force point cost from the spells.2da `forcepoints` column; `****` parses to -1 and means free.
   * Alignment / Force Focus cost modifiers are not applied.
   */
  static GetSpellForceCost(spell: TalentSpell): number {
    const cost = Number(spell?.forcepoints);
    return Number.isFinite(cost) && cost > 0 ? cost : 0;
  }

  static CanAffordSpell(caster: ModuleObject, spell: TalentSpell): boolean {
    const cost = ActionCastSpell.GetSpellForceCost(spell);
    if(cost <= 0) return true;
    if(!BitWise.InstanceOfObject(caster, ModuleObjectType.ModuleCreature)) return true;
    return (caster as ModuleCreature).getFP() >= cost;
  }

}
