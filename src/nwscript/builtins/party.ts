import * as THREE from "three";
import type EngineLocation from "@/engine/EngineLocation";
import { NWScriptDataType } from "@/enums/nwscript/NWScriptDataType";
import { GameState } from "@/GameState";
import type { ModuleCreature, ModuleObject } from "@/module";
import type { OdysseyModel3D } from "@/three/odyssey";
import { BitWise } from "@/utility/BitWise";
import { NW_FALSE, NW_TRUE } from "@/nwscript/NWScriptConstants";
import type { NWScriptInstance } from "@/nwscript/NWScriptInstance";
import { defineAction, floatParam, intParam, locationParam, objectParam, stringParam } from "@/nwscript/builtins/actionBuilder";
import { ActionParameterType } from "@/enums/actions/ActionParameterType";
import { ModuleObjectType } from "@/enums/module/ModuleObjectType";

export const SetPartyLeader = defineAction({
  id: 13,
  name: "SetPartyLeader",
  comment: "13: Set which party member should be the controlled character.",
  returnType: NWScriptDataType.INTEGER,
  params: [
    intParam("nNPCId"),
  ] as const,

  kotor(this: NWScriptInstance, nNPCId) {
    const pm = GameState.PartyManager.GetPMByNPCId(nNPCId);
    if (!pm) {
      return NW_FALSE;
    }

    return GameState.PartyManager.party.unshift(
      GameState.PartyManager.party.splice(
        GameState.PartyManager.party.indexOf(pm),
        1,
      )[0],
    )
      ? NW_TRUE
      : NW_FALSE;
  },
});

export const GetPartyMemberCount = defineAction({
  id: 126,
  name: "GetPartyMemberCount",
  comment: "126: Return a count of how many members are in the party including the player character.",
  returnType: NWScriptDataType.INTEGER,
  params: [] as const,

  kotor(this: NWScriptInstance) {
    return GameState.PartyManager.party.length;
  },
});

export const AddPartyMember = defineAction({
  id: 574,
  name: "AddPartyMember",
  comment: "574: Add a creature to the party.",
  returnType: NWScriptDataType.INTEGER,
  params: [
    intParam("nNPCId"),
    objectParam<ModuleObject | undefined>("oCreature", { optional: true, default: undefined }),
  ] as const,

  kotor(this: NWScriptInstance, nNPCId, oCreature) {
    if (BitWise.InstanceOfObject(oCreature, ModuleObjectType.ModuleCreature)) {
      return GameState.PartyManager.AddCreatureToParty(nNPCId, oCreature as ModuleCreature) ? NW_TRUE : NW_FALSE;
    }

    return NW_FALSE;
  },
});

export const RemovePartyMember = defineAction({
  id: 575,
  name: "RemovePartyMember",
  comment: "575: Remove a creature from the party.",
  returnType: NWScriptDataType.INTEGER,
  params: [
    intParam("nNPCId"),
  ] as const,

  kotor(this: NWScriptInstance, nNPCId) {
    GameState.PartyManager.RemoveNPCById(nNPCId, true);
    return 0;
  },
});

export const IsObjectPartyMember = defineAction({
  id: 576,
  name: "IsObjectPartyMember",
  comment: "576: Return whether a specified creature is a party member.",
  returnType: NWScriptDataType.INTEGER,
  params: [
    objectParam<ModuleCreature>("oCreature"),
  ] as const,

  kotor(this: NWScriptInstance, oCreature) {
    return GameState.PartyManager.party.indexOf(oCreature) >= 0 || oCreature === GameState.PartyManager.Player
      ? NW_TRUE
      : NW_FALSE;
  },
});

export const GetPartyMemberByIndex = defineAction({
  id: 577,
  name: "GetPartyMemberByIndex",
  comment: "577: Return the party member at a given index in the party.",
  returnType: NWScriptDataType.OBJECT,
  params: [
    intParam("nIndex"),
  ] as const,

  kotor(this: NWScriptInstance, nIndex) {
    return GameState.PartyManager.party[nIndex];
  },
});

export const AddAvailableNPCByObject = defineAction({
  id: 694,
  name: "AddAvailableNPCByObject",
  comment: "694: Add an NPC to the list of available party members using a game object as the template.",
  returnType: NWScriptDataType.INTEGER,
  params: [
    intParam("nNPCId"),
    objectParam<ModuleObject>("oCreature"),
  ] as const,

  kotor(this: NWScriptInstance, nNPCId, oCreature) {
    return GameState.PartyManager.AddAvailableNPCByObject(nNPCId, oCreature as ModuleCreature)
      ? NW_TRUE
      : NW_FALSE;
  },
});

export const RemoveAvailableNPC = defineAction({
  id: 695,
  name: "RemoveAvailableNPC",
  comment: "695: Remove an NPC from the list of available party members.",
  returnType: NWScriptDataType.INTEGER,
  params: [
    intParam("nNPCId"),
  ] as const,

  kotor(this: NWScriptInstance, nNPCId) {
    GameState.PartyManager.RemoveAvailableNPC(nNPCId);
    return NW_TRUE;
  },
});

export const IsAvailableCreature = defineAction({
  id: 696,
  name: "IsAvailableCreature",
  comment: "696: Return whether an NPC is in the list of available party members.",
  returnType: NWScriptDataType.INTEGER,
  params: [
    intParam("nNPCId"),
  ] as const,

  kotor(this: NWScriptInstance, nNPCId) {
    return GameState.PartyManager.IsAvailable(nNPCId) ? NW_TRUE : NW_FALSE;
  },
});

export const AddAvailableNPCByTemplate = defineAction({
  id: 697,
  name: "AddAvailableNPCByTemplate",
  comment: "697: Add an NPC to the list of available party members using a template.",
  returnType: NWScriptDataType.INTEGER,
  params: [
    intParam("nNPCId"),
    objectParam<string>("sTemplate", { type: NWScriptDataType.STRING } as any),
  ] as const,

  kotor(this: NWScriptInstance, nNPCId, sTemplate) {
    return GameState.PartyManager.AddAvailableNPCByTemplate(nNPCId, sTemplate)
      ? NW_TRUE
      : NW_FALSE;
  },
});

export const SpawnAvailableNPC = defineAction({
  id: 698,
  name: "SpawnAvailableNPC",
  comment: "698: Spawn an NPC from the list of available creatures.",
  returnType: NWScriptDataType.OBJECT,
  params: [
    intParam("nNPCId"),
    locationParam<EngineLocation>("lLocation"),
  ] as const,

  kotor(this: NWScriptInstance, nNPCId, lLocation) {
    return spawnCreatureFromTemplate(GameState.PartyManager.NPCS[nNPCId]?.template, lLocation);
  },
});

function spawnCreatureFromTemplate(template: any, lLocation: EngineLocation): ModuleCreature | undefined {
  if (!template) {
    return undefined;
  }

  // A fresh copy without ObjectIds: the slot template may carry a live companion's ids (creature and items).
  const partyMember = new GameState.Module.ModuleArea.ModuleCreature(GameState.PartyManager.CloneWithoutObjectIds(template));
  lLocation.area.attachObject(partyMember);
  partyMember.load();
  partyMember.clearAllActions();

  partyMember.loadModel().then((model: OdysseyModel3D) => {
    partyMember.model.userData.moduleObject = partyMember;
    partyMember.setPosition(lLocation.position);
    partyMember.setFacing(lLocation.getFacing(), true);
    partyMember.box = new THREE.Box3().setFromObject(partyMember.container);
    model.hasCollision = true;
    GameState.group.creatures.add(partyMember.container);
    partyMember.getCurrentRoom();
    partyMember.onSpawn();
  });

  return partyMember;
}

export const GetInfluence = defineAction({
  availability: "tsl",
  id: 795,
  name: "GetInfluence",
  comment: "795: Get the PC's influence on the alignment of a CNPC. Returns 0 if nNPC is not a CNPC.",
  returnType: NWScriptDataType.INTEGER,
  params: [intParam("nNPC")] as const,
  tsl(this: NWScriptInstance, nNPC) {
    return GameState.PartyManager.GetInfluence(nNPC);
  },
});

export const SetInfluence = defineAction({
  availability: "tsl",
  id: 796,
  name: "SetInfluence",
  comment: "796: Set the PC's influence on the alignment of a CNPC. Does nothing if nNPC is not a CNPC or nInfluence is outside 0-100.",
  returnType: NWScriptDataType.VOID,
  params: [intParam("nNPC"), intParam("nInfluence")] as const,
  tsl(this: NWScriptInstance, nNPC, nInfluence) {
    GameState.PartyManager.SetInfluence(nNPC, nInfluence);
  },
});

export const ModifyInfluence = defineAction({
  availability: "tsl",
  id: 797,
  name: "ModifyInfluence",
  comment: "797: Modify the PC's influence on the alignment of a CNPC; the result is clamped to 0-100.",
  returnType: NWScriptDataType.VOID,
  params: [intParam("nNPC"), intParam("nModifier")] as const,
  tsl(this: NWScriptInstance, nNPC, nModifier) {
    GameState.PartyManager.ModifyInfluence(nNPC, nModifier);
  },
});

export const SetFormation = defineAction({
  id: 729,
  name: "SetFormation",
  comment: "729: Put oCreature into the nFormationPattern (FORMATION_*) about oAnchor at position nPosition (1-10).",
  returnType: NWScriptDataType.VOID,
  params: [
    objectParam<ModuleObject | undefined>("oAnchor"),
    objectParam<ModuleObject | undefined>("oCreature"),
    intParam("nFormationPattern"),
    intParam("nPosition"),
  ] as const,
  kotor(this: NWScriptInstance, oAnchor, oCreature, nFormationPattern, nPosition) {
    GameState.PartyManager.SetFormation(oAnchor as ModuleCreature, oCreature as ModuleCreature, nFormationPattern, nPosition);
  },
});

export const AddAvailablePUPByTemplate = defineAction({
  availability: "tsl",
  id: 836,
  name: "AddAvailablePUPByTemplate",
  comment: "836: Add a puppet to the puppet table by template. Does not spawn it.",
  returnType: NWScriptDataType.INTEGER,
  params: [intParam("nPUP"), stringParam("sTemplate")] as const,
  tsl(this: NWScriptInstance, nPUP, sTemplate) {
    return GameState.PartyManager.AddAvailablePUPByTemplate(nPUP, sTemplate) ? NW_TRUE : NW_FALSE;
  },
});

export const AddAvailablePUPByObject = defineAction({
  availability: "tsl",
  id: 837,
  name: "AddAvailablePUPByObject",
  comment: "837: Add a puppet to the puppet table from an existing creature.",
  returnType: NWScriptDataType.INTEGER,
  params: [intParam("nPUP"), objectParam<ModuleObject | undefined>("oPuppet")] as const,
  tsl(this: NWScriptInstance, nPUP, oPuppet) {
    return GameState.PartyManager.AddAvailablePUPByObject(nPUP, oPuppet as ModuleCreature) ? NW_TRUE : NW_FALSE;
  },
});

export const AssignPUP = defineAction({
  availability: "tsl",
  id: 838,
  name: "AssignPUP",
  comment: "838: Assign a puppet to its owner NPC (NPC_* or NPC_PLAYER).",
  returnType: NWScriptDataType.INTEGER,
  params: [intParam("nPUP"), intParam("nNPC")] as const,
  tsl(this: NWScriptInstance, nPUP, nNPC) {
    return GameState.PartyManager.AssignPUP(nPUP, nNPC) ? NW_TRUE : NW_FALSE;
  },
});

export const SpawnAvailablePUP = defineAction({
  availability: "tsl",
  id: 839,
  name: "SpawnAvailablePUP",
  comment: "839: Spawn a puppet from the puppet table at lLocation.",
  returnType: NWScriptDataType.OBJECT,
  params: [intParam("nPUP"), locationParam<EngineLocation>("lLocation")] as const,
  tsl(this: NWScriptInstance, nPUP, lLocation) {
    const puppet = GameState.PartyManager.Puppets[nPUP];
    if (!puppet?.available) {
      return undefined;
    }
    const creature = spawnCreatureFromTemplate(puppet.template, lLocation);
    GameState.PartyManager.RelinkPuppet(creature, nPUP);
    return creature;
  },
});

export const AddPartyPuppet = defineAction({
  availability: "tsl",
  id: 840,
  name: "AddPartyPuppet",
  comment: "840: Add an existing, available puppet creature to the party.",
  returnType: NWScriptDataType.INTEGER,
  params: [intParam("nPUP"), objectParam<ModuleObject | undefined>("oidCreature")] as const,
  tsl(this: NWScriptInstance, nPUP, oidCreature) {
    return GameState.PartyManager.AddPartyPuppet(nPUP, oidCreature as ModuleCreature) ? NW_TRUE : NW_FALSE;
  },
});

export const GetPUPOwner = defineAction({
  availability: "tsl",
  id: 841,
  name: "GetPUPOwner",
  comment: "841: Get the owner of a party puppet.",
  returnType: NWScriptDataType.OBJECT,
  params: [objectParam<ModuleObject | undefined>("oPUP", { optional: true, default: undefined })] as const,
  tsl(this: NWScriptInstance, oPUP) {
    return GameState.PartyManager.GetPuppetOwner(oPUP as ModuleCreature);
  },
});

export const GetIsPuppet = defineAction({
  availability: "tsl",
  id: 842,
  name: "GetIsPuppet",
  comment: "842: Determine whether the target is a party puppet.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject | undefined>("oPUP", { optional: true, default: undefined })] as const,
  tsl(this: NWScriptInstance, oPUP) {
    return GameState.PartyManager.GetPuppetId(oPUP as ModuleCreature) >= 0 ? NW_TRUE : NW_FALSE;
  },
});

export const ActionFollowOwner = defineAction({
  availability: "tsl",
  id: 843,
  name: "ActionFollowOwner",
  comment: "843: Have the puppet follow its owner.",
  returnType: NWScriptDataType.VOID,
  params: [floatParam("fRange", { optional: true, default: 2.5 })] as const,
  tsl(this: NWScriptInstance, fRange) {
    if (!BitWise.InstanceOfObject(this.caller, ModuleObjectType.ModuleCreature)) return;
    const owner = GameState.PartyManager.GetPuppetOwner(this.caller as ModuleCreature);
    if (!owner || owner === this.caller) return;
    const action = new GameState.ActionFactory.ActionForceFollowObject();
    action.setParameter(0, ActionParameterType.DWORD, owner.id);
    action.setParameter(1, ActionParameterType.FLOAT, fRange);
    (this.caller as ModuleCreature).actionQueue.add(action);
  },
});

export const IsNPCPartyMember = defineAction({
  id: 699,
  name: "IsNPCPartyMember",
  comment: "699: Return whether a given NPC constant is currently in the party.",
  returnType: NWScriptDataType.INTEGER,
  params: [
    intParam("nNPCId"),
  ] as const,

  kotor(this: NWScriptInstance, nNPCId) {
    return GameState.PartyManager.IsNPCInParty(nNPCId) ? NW_TRUE : NW_FALSE;
  },
});

export const partyActions = [
  SetPartyLeader,
  GetPartyMemberCount,
  AddPartyMember,
  RemovePartyMember,
  IsObjectPartyMember,
  GetPartyMemberByIndex,
  AddAvailableNPCByObject,
  RemoveAvailableNPC,
  IsAvailableCreature,
  AddAvailableNPCByTemplate,
  SpawnAvailableNPC,
  IsNPCPartyMember,
  GetInfluence,
  SetInfluence,
  ModifyInfluence,
  SetFormation,
  AddAvailablePUPByTemplate,
  AddAvailablePUPByObject,
  AssignPUP,
  SpawnAvailablePUP,
  AddPartyPuppet,
  GetPUPOwner,
  GetIsPuppet,
  ActionFollowOwner,
] as const;
