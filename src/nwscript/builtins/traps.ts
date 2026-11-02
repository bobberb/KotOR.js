import { ModuleObjectType } from "@/enums/module/ModuleObjectType";
import { NWScriptDataType } from "@/enums/nwscript/NWScriptDataType";
import type { ModuleObject } from "@/module";
import type { ModuleTrigger } from "@/module/ModuleTrigger";
import type EngineLocation from "@/engine/EngineLocation";
import { SWTrapRules } from "@/engine/rules/SWTrapRules";
import { BitWise } from "@/utility/BitWise";
import { NW_FALSE, NW_TRUE } from "@/nwscript/NWScriptConstants";
import type { NWScriptInstance } from "@/nwscript/NWScriptInstance";
import { defineAction, intParam, locationParam, objectParam } from "@/nwscript/builtins/actionBuilder";
import { ModuleTriggerType } from "@/enums/module/ModuleTriggerType";

/**
 * Whether oObject is an armed trap. A trap trigger is armed unless disabled
 * (TrapFlag 0), spent or destroyed (ModuleTrigger.isTrapArmed: an unset TrapFlag
 * counts as armed); a door/placeable by its TrapFlag.
 */
export function isObjectTrapped(object: any): boolean {
  if (!object) return false;
  if (BitWise.InstanceOfObject(object, ModuleObjectType.ModuleTrigger) && object.type == ModuleTriggerType.TRAP &&
      typeof object.isTrapArmed === 'function') {
    return !object.destroyed && !object.trapSpent && object.isTrapArmed();
  }
  return !!object.trapFlag;
}

export const GetTrapDisarmable = defineAction({
  id: 527,
  name: "GetTrapDisarmable",
  comment: "527: Return TRUE if oTrapObject is disarmable.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oTrapObject")] as const,
  kotor(this: NWScriptInstance, oTrapObject) {
    if (BitWise.InstanceOfObject(oTrapObject, ModuleObjectType.ModuleObject)) {
      return oTrapObject.trapDisarmable ? NW_TRUE : NW_FALSE;
    }
    return NW_FALSE;
  },
});

export const GetTrapDetectable = defineAction({
  id: 528,
  name: "GetTrapDetectable",
  comment: "528: Return TRUE if oTrapObject is detectable.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oTrapObject")] as const,
  kotor(this: NWScriptInstance, oTrapObject) {
    if (BitWise.InstanceOfObject(oTrapObject, ModuleObjectType.ModuleObject)) {
      return oTrapObject.trapDetectable ? NW_TRUE : NW_FALSE;
    }
    return NW_FALSE;
  },
});

export const GetTrapFlagged = defineAction({
  id: 530,
  name: "GetTrapFlagged",
  comment: "530: Return TRUE if oTrapObject has been flagged as visible to all creatures.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oTrapObject")] as const,
  kotor(this: NWScriptInstance, oTrapObject) {
    if (BitWise.InstanceOfObject(oTrapObject, ModuleObjectType.ModuleObject)) {
      return isObjectTrapped(oTrapObject) ? NW_TRUE : NW_FALSE;
    }
    return NW_FALSE;
  },
});

export const GetTrapBaseType = defineAction({
  id: 531,
  name: "GetTrapBaseType",
  comment: "531: Get the trap base type of oTrapObject.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oTrapObject")] as const,
  kotor(this: NWScriptInstance, oTrapObject) {
    if (BitWise.InstanceOfObject(oTrapObject, ModuleObjectType.ModuleObject)) {
      return oTrapObject.trapType;
    }
    return -1;
  },
});

export const GetTrapOneShot = defineAction({
  id: 532,
  name: "GetTrapOneShot",
  comment: "532: Return TRUE if oTrapObject is one-shot.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oTrapObject")] as const,
  kotor(this: NWScriptInstance, oTrapObject) {
    if (BitWise.InstanceOfObject(oTrapObject, ModuleObjectType.ModuleObject)) {
      return oTrapObject.trapOneShot ? NW_TRUE : NW_FALSE;
    }
    return NW_FALSE;
  },
});

export const GetTrapDisarmDC = defineAction({
  id: 535,
  name: "GetTrapDisarmDC",
  comment: "535: Get the DC for disarming oTrapObject.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oTrapObject")] as const,
  kotor(this: NWScriptInstance, oTrapObject) {
    if (BitWise.InstanceOfObject(oTrapObject, ModuleObjectType.ModuleObject)) {
      return oTrapObject.trapDisarmDC;
    }
    return NW_FALSE;
  },
});

export const GetTrapDetectDC = defineAction({
  id: 536,
  name: "GetTrapDetectDC",
  comment: "536: Get the DC for detecting oTrapObject.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oTrapObject")] as const,
  kotor(this: NWScriptInstance, oTrapObject) {
    if (BitWise.InstanceOfObject(oTrapObject, ModuleObjectType.ModuleObject)) {
      return oTrapObject.trapDetectDC;
    }
    return NW_FALSE;
  },
});

export const GetIsTrapped = defineAction({
  id: 551,
  name: "GetIsTrapped",
  comment: "551: Return TRUE if oObject is trapped.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oObject")] as const,
  kotor(this: NWScriptInstance, oObject) {
    if (
      BitWise.InstanceOfObject(oObject, ModuleObjectType.ModuleTrigger) ||
      BitWise.InstanceOfObject(oObject, ModuleObjectType.ModuleDoor) ||
      BitWise.InstanceOfObject(oObject, ModuleObjectType.ModulePlaceable)
    ) {
      return isObjectTrapped(oObject) ? NW_TRUE : NW_FALSE;
    }
    return NW_FALSE;
  },
});

const isTrappable = (object: any): boolean =>
  BitWise.InstanceOfObject(object, ModuleObjectType.ModuleTrigger) ||
  BitWise.InstanceOfObject(object, ModuleObjectType.ModuleDoor) ||
  BitWise.InstanceOfObject(object, ModuleObjectType.ModulePlaceable);

const isLockable = (object: any): boolean =>
  BitWise.InstanceOfObject(object, ModuleObjectType.ModuleDoor) ||
  BitWise.InstanceOfObject(object, ModuleObjectType.ModulePlaceable);

export const GetLastLocked = defineAction({
  id: 349,
  name: "GetLastLocked",
  comment: "349: Get the last object that locked the caller (door or placeable).",
  returnType: NWScriptDataType.OBJECT,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return isLockable(this.caller) ? this.caller.lastLocked : undefined;
  },
});

export const GetLastUnlocked = defineAction({
  id: 350,
  name: "GetLastUnlocked",
  comment: "350: Get the last object that unlocked the caller (door or placeable).",
  returnType: NWScriptDataType.OBJECT,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return isLockable(this.caller) ? this.caller.lastUnlocked : undefined;
  },
});

export const GetLastTrapDetected = defineAction({
  id: 486,
  name: "GetLastTrapDetected",
  comment: "486: Get the last trap detected by oTarget.\n* Return value on error: OBJECT_INVALID",
  returnType: NWScriptDataType.OBJECT,
  params: [objectParam<ModuleObject>("oTarget", { optional: true, default: undefined })] as const,
  kotor(this: NWScriptInstance, oTarget) {
    const target = oTarget ?? this.caller;
    if (!BitWise.InstanceOfObject(target, ModuleObjectType.ModuleObject)) return undefined;
    const trap = target.lastTrapDetected;
    return trap && !trap.destroyed ? trap : undefined;
  },
});

export const GetTrapDetectedBy = defineAction({
  id: 529,
  name: "GetTrapDetectedBy",
  comment: "529: Return TRUE if oCreature has detected oTrapObject (detection is shared by the creature's faction).",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oTrapObject"), objectParam<ModuleObject>("oCreature")] as const,
  kotor(this: NWScriptInstance, oTrapObject, oCreature) {
    if (!isTrappable(oTrapObject) || !BitWise.InstanceOfObject(oCreature, ModuleObjectType.ModuleObject)) return NW_FALSE;
    return oTrapObject.isTrapDetectedBy(oCreature) ? NW_TRUE : NW_FALSE;
  },
});

export const GetTrapCreator = defineAction({
  id: 533,
  name: "GetTrapCreator",
  comment: "533: Get the creator of oTrapObject, the creature that set the trap.\n* Returns OBJECT_INVALID if oTrapObject was created in the toolset.",
  returnType: NWScriptDataType.OBJECT,
  params: [objectParam<ModuleObject>("oTrapObject")] as const,
  kotor(this: NWScriptInstance, oTrapObject) {
    if (!isTrappable(oTrapObject)) return undefined;
    return oTrapObject.getTrapCreator();
  },
});

export const GetTrapKeyTag = defineAction({
  id: 534,
  name: "GetTrapKeyTag",
  comment: "534: Get the tag of the key that will disarm oTrapObject.",
  returnType: NWScriptDataType.STRING,
  params: [objectParam<ModuleObject>("oTrapObject")] as const,
  kotor(this: NWScriptInstance, oTrapObject) {
    // Only trap triggers carry a trap key (UTT KeyName); a door/placeable KeyName is its lock key.
    if (!BitWise.InstanceOfObject(oTrapObject, ModuleObjectType.ModuleTrigger)) return '';
    return oTrapObject.keyName || '';
  },
});

export const SetTrapDetectedBy = defineAction({
  id: 550,
  name: "SetTrapDetectedBy",
  comment: "550: Set oDetector (and its faction) as having detected oTrap.\n* Returns TRUE on success.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oTrap"), objectParam<ModuleObject>("oDetector")] as const,
  kotor(this: NWScriptInstance, oTrap, oDetector) {
    if (!isTrappable(oTrap) || !BitWise.InstanceOfObject(oDetector, ModuleObjectType.ModuleObject)) return NW_FALSE;
    if (BitWise.InstanceOfObject(oTrap, ModuleObjectType.ModuleTrigger)) {
      (oTrap as unknown as ModuleTrigger).detectTrap(oDetector);
    } else {
      oTrap.setTrapDetectedBy(oDetector, true);
    }
    return NW_TRUE;
  },
});

export const SpawnMine = defineAction({
  availability: "tsl",
  id: 788,
  name: "SpawnMine",
  comment: "788: Spawn a mine of nMineType (traps.2da row) at lPoint. DCs are the given bases plus the traps.2da DC modifiers; oCreator's faction owns it.",
  returnType: NWScriptDataType.VOID,
  params: [
    intParam("nMineType"),
    locationParam<EngineLocation>("lPoint"),
    intParam("nDetectDCBase"),
    intParam("nDisarmDCBase"),
    objectParam<ModuleObject>("oCreator"),
  ] as const,
  tsl(this: NWScriptInstance, nMineType, lPoint, nDetectDCBase, nDisarmDCBase, oCreator) {
    if (!lPoint?.position) return;
    const row = SWTrapRules.trapRow(nMineType);
    if (!row) return;
    const creator = BitWise.InstanceOfObject(oCreator, ModuleObjectType.ModuleObject) ? oCreator : undefined;
    SWTrapRules.spawnMine(
      nMineType,
      lPoint.position,
      (nDetectDCBase | 0) + SWTrapRules.dcMod(row.detectdcmod),
      (nDisarmDCBase | 0) + SWTrapRules.dcMod(row.disarmdcmod),
      creator,
      lPoint.area ?? creator?.area,
    );
  },
});

export const trapsActions = [
  GetLastLocked,
  GetLastUnlocked,
  GetLastTrapDetected,
  GetTrapDetectedBy,
  GetTrapCreator,
  GetTrapKeyTag,
  SetTrapDetectedBy,
  SpawnMine,
  GetTrapDisarmable,
  GetTrapDetectable,
  GetTrapFlagged,
  GetTrapBaseType,
  GetTrapOneShot,
  GetTrapDisarmDC,
  GetTrapDetectDC,
  GetIsTrapped,
] as const;
