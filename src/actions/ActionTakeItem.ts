import { GameState } from "@/GameState";
import { ActionStatus } from "@/enums/actions/ActionStatus";
import { ActionType } from "@/enums/actions/ActionType";
import { ModuleObjectType } from "@/enums/module/ModuleObjectType";
import type { ModuleItem } from "@/module/ModuleItem";
import type { ModuleObject } from "@/module/ModuleObject";
import { BitWise } from "@/utility/BitWise";
import { Action } from "@/actions/Action";

/**
 * ActionTakeItem class.
 * 
 * KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
 * 
 * @file ActionTakeItem.ts
 * @author KobaltBlu <https://github.com/KobaltBlu>
 * @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
 */
export class ActionTakeItem extends Action {

  constructor( actionId: number = -1, groupId: number = -1 ){
    super(actionId, groupId);
    this.type = ActionType.ActionTakeItem;

    //PARAMS
    // 0 - dword: oItem
    // 1 - dword: oTakeFrom
  }

  update(delta?: number): ActionStatus {

    if(
      !BitWise.InstanceOfObject(this.owner, ModuleObjectType.ModuleCreature) &&
      !BitWise.InstanceOfObject(this.owner, ModuleObjectType.ModulePlaceable) &&
      !BitWise.InstanceOfObject(this.owner, ModuleObjectType.ModuleStore)
    ){
      return ActionStatus.FAILED;
    }

    const oItem = this.getParameter<ModuleItem>(0);
    if(!BitWise.InstanceOfObject(oItem, ModuleObjectType.ModuleItem)){
      return ActionStatus.FAILED;
    }

    const oTarget = this.getParameter<ModuleObject>(1);
    if(
      !BitWise.InstanceOfObject(oTarget, ModuleObjectType.ModuleCreature) &&
      !BitWise.InstanceOfObject(oTarget, ModuleObjectType.ModulePlaceable) &&
      !BitWise.InstanceOfObject(oTarget, ModuleObjectType.ModuleStore)
    ){
      return ActionStatus.FAILED;
    }

    const party = GameState.PartyManager.party;
    if(party.indexOf(this.owner as any) >= 0 && party.indexOf(oTarget as any) >= 0){
      // The party shares one inventory: nothing changes hands, no item events.
      return ActionStatus.COMPLETE;
    }

    const removed = oTarget.removeItem(oItem, 1);
    if(!removed){
      return ActionStatus.FAILED;
    }

    if(party.indexOf(this.owner as any) >= 0){
      GameState.InventoryManager.addItem(removed, false, { acquiredFrom: oTarget });
    }else{
      this.owner.addItem(removed);
    }

    return ActionStatus.COMPLETE;
  }

}
