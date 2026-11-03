import EngineLocation from "@/engine/EngineLocation";
import { GameState } from "@/GameState";
import { ModuleObjectType } from "@/enums/module/ModuleObjectType";
import { NWScriptDataType } from "@/enums/nwscript/NWScriptDataType";
import type { ModuleObject } from "@/module";
import { BitWise } from "@/utility/BitWise";
import { NW_FALSE, NW_TRUE } from "@/nwscript/NWScriptConstants";
import type { NWScriptInstance } from "@/nwscript/NWScriptInstance";
import { defineAction, intParam, objectParam } from "@/nwscript/builtins/actionBuilder";

interface ILocalVariableOwner {
  getLocalBoolean(index: number): boolean;
  setLocalBoolean(index: number, value: boolean): void;
  getLocalNumber(index: number): number;
  setLocalNumber(index: number, value: number): void;
}

/** Module objects and the module itself (GetModule()) carry locals. */
function localsOwner(oObject: unknown): ILocalVariableOwner | undefined {
  if (BitWise.InstanceOfObject(oObject, ModuleObjectType.ModuleObject)) {
    return oObject as ILocalVariableOwner;
  }
  if (oObject && oObject === GameState.module) {
    return oObject as unknown as ILocalVariableOwner;
  }
  return undefined;
}

export const GetRunScriptVar = defineAction({
  id: 565,
  name: "GetRunScriptVar",
  comment: "565: Get a variable passed when calling console debug runscript.",
  returnType: NWScriptDataType.INTEGER,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return this.scriptVar;
  },
});

export const GetLocalBoolean = defineAction({
  id: 679,
  name: "GetLocalBoolean",
  comment: "679: Get a local boolean flag on an object.",
  returnType: NWScriptDataType.INTEGER,
  params: [
    objectParam<ModuleObject>("oObject"),
    intParam("nIndex"),
  ] as const,
  kotor(this: NWScriptInstance, oObject, nIndex) {
    return localsOwner(oObject)?.getLocalBoolean(nIndex) ? NW_TRUE : NW_FALSE;
  },
});

export const SetLocalBoolean = defineAction({
  id: 680,
  name: "SetLocalBoolean",
  comment: "680: Set a local boolean flag on an object.",
  returnType: NWScriptDataType.VOID,
  params: [
    objectParam<ModuleObject>("oObject"),
    intParam("nIndex"),
    intParam("bValue"),
  ] as const,
  kotor(this: NWScriptInstance, oObject, nIndex, bValue) {
    localsOwner(oObject)?.setLocalBoolean(nIndex, !!bValue);
  },
});

export const GetLocalNumber = defineAction({
  id: 681,
  name: "GetLocalNumber",
  comment: "681: Get a local number on an object.",
  returnType: NWScriptDataType.INTEGER,
  params: [
    objectParam<ModuleObject>("oObject"),
    intParam("nIndex"),
  ] as const,
  kotor(this: NWScriptInstance, oObject, nIndex) {
    return localsOwner(oObject)?.getLocalNumber(nIndex) ?? 0;
  },
});

export const SetLocalNumber = defineAction({
  id: 682,
  name: "SetLocalNumber",
  comment: "682: Set a local number on an object.",
  returnType: NWScriptDataType.VOID,
  params: [
    objectParam<ModuleObject>("oObject"),
    intParam("nIndex"),
    intParam("nValue"),
  ] as const,
  kotor(this: NWScriptInstance, oObject, nIndex, nValue) {
    localsOwner(oObject)?.setLocalNumber(nIndex, nValue);
  },
});

export const localvarsActions = [
  GetRunScriptVar,
  GetLocalBoolean,
  SetLocalBoolean,
  GetLocalNumber,
  SetLocalNumber,
] as const;
