import { GameState } from "@/GameState";
import { ActionParameterType } from "@/enums/actions/ActionParameterType";
import { ActionStatus } from "@/enums/actions/ActionStatus";
import { ActionType } from "@/enums/actions/ActionType";
import { ModuleObjectType } from "@/enums/module/ModuleObjectType";
import { ModuleTriggerType } from "@/enums/module/ModuleTriggerType";
import type { ModuleObject } from "@/module/ModuleObject";
import type { ModuleTrigger } from "@/module/ModuleTrigger";
import { BitWise } from "@/utility/BitWise";
import { Utility } from "@/utility/Utility";
import { Action } from "@/actions/Action";
import { enqueueMoveToPoint } from "@/actions/helpers/enqueueMoveToPoint";
import { SWTrapRules, TrapAttemptResult } from "@/engine/rules/SWTrapRules";

/**
 * ActionRecoverMine class.
 * 
 * KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
 * 
 * @file ActionRecoverMine.ts
 * @author KobaltBlu <https://github.com/KobaltBlu>
 * @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
 */

export class ActionRecoverMine extends Action {
  result: TrapAttemptResult;

  constructor( actionId: number = -1, groupId: number = -1 ){
    super(actionId, groupId);
    this.type = ActionType.ActionRecoverMine;

    //PARAMS - unknown
    //0 - DWORD: oTarget
  }

  update(delta?: number): ActionStatus {

    this.target = this.getParameter<ModuleObject>(0);
    if(!this.target){
      return ActionStatus.FAILED;
    }

    if(BitWise.InstanceOfObject(this.owner, ModuleObjectType.ModuleCreature)){
      let distance = Utility.Distance2D(this.owner.position, this.target.position);
            
      if(distance > 3){
        // this.owner.openSpot = undefined;
        enqueueMoveToPoint(this.owner, {
          x: this.target.position.x,
          y: this.target.position.y,
          z: this.target.position.z,
          area: this.target.area.id,
          target: this.target.id,
          run: true,
          range: 3,
          timeout: 30.0,
          groupId: this.groupId,
        });

        return ActionStatus.IN_PROGRESS;
      }

      if(BitWise.InstanceOfObject(this.target, ModuleObjectType.ModuleTrigger)){
        const trap: ModuleTrigger = this.target as any;
        if(trap.type != ModuleTriggerType.TRAP){
          return ActionStatus.FAILED;
        }

        this.result = SWTrapRules.attemptRecover(this.owner, trap);
        return this.result.outcome == 'success' ? ActionStatus.COMPLETE : ActionStatus.FAILED;
      }

      return ActionStatus.FAILED;
    }
    
    return ActionStatus.FAILED;
  }

}