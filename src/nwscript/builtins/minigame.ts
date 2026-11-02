import * as THREE from "three";
import { ModuleObjectType } from "@/enums/module/ModuleObjectType";
import { MiniGameType } from "@/enums/engine/MiniGameType";
import { NWScriptDataType } from "@/enums/nwscript/NWScriptDataType";
import { GameState } from "@/GameState";
import type { ModuleMGEnemy, ModuleMGObstacle, ModuleMGPlayer, ModuleObject } from "@/module";
import type { ModuleMiniGame, IMiniGameCombatant } from "@/module/ModuleMiniGame";
import type { ModuleMGGunBank } from "@/module/ModuleMGGunBank";
import { BitWise } from "@/utility/BitWise";
import { NW_FALSE, NW_TRUE } from "@/nwscript/NWScriptConstants";
import type { NWScriptInstance } from "@/nwscript/NWScriptInstance";
import { defineAction, floatParam, intParam, objectParam, stringParam, vectorParam } from "@/nwscript/builtins/actionBuilder";

/*
 * Swoop/turret minigame routines. Engine state lives on ModuleMiniGame and its
 * player/follower/obstacle objects; the SWMG_GetLast* routines read the event
 * context ModuleMiniGame.dispatchEvent installs for the script being run.
 */

type Vec = { x: number; y: number; z: number };
type MGObject = ModuleMGPlayer | ModuleMGEnemy | ModuleMGObstacle;

export function mgGetMiniGame(): ModuleMiniGame | undefined {
  return GameState.module?.area?.miniGame;
}

export function mgIsObject(object: unknown): object is MGObject {
  return BitWise.InstanceOfObject(object, ModuleObjectType.ModuleMGPlayer) ||
    BitWise.InstanceOfObject(object, ModuleObjectType.ModuleMGEnemy) ||
    BitWise.InstanceOfObject(object, ModuleObjectType.ModuleMGObstacle);
}

function mgPlayer(): ModuleMGPlayer | undefined {
  return mgGetMiniGame()?.player;
}

function mgGunBank(object: unknown, index: number): ModuleMGGunBank | undefined {
  if(!mgIsObject(object)){ return undefined; }
  const banks = (object as any).gunBanks as ModuleMGGunBank[] | undefined;
  return Array.isArray(banks) ? banks[index] : undefined;
}

function vec(x = 0, y = 0, z = 0): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

function radiansToDegrees(value: Vec): THREE.Vector3 {
  return vec(THREE.MathUtils.radToDeg(value?.x || 0), THREE.MathUtils.radToDeg(value?.y || 0), THREE.MathUtils.radToDeg(value?.z || 0));
}

function setFromDegrees(target: Vec, value: Vec){
  target.x = THREE.MathUtils.degToRad(value?.x || 0);
  target.y = THREE.MathUtils.degToRad(value?.y || 0);
  target.z = THREE.MathUtils.degToRad(value?.z || 0);
}

/** Engine default for OnBulletHit: the script's object takes the bullet's damage. */
export function mgDefaultOnBulletHit(caller: unknown){
  const miniGame = mgGetMiniGame();
  if(!miniGame || !mgIsObject(caller)){ return; }
  (caller as MGObject).damage(miniGame.context.bulletHitDamage);
}

/** Engine default for OnHitObstacle/OnHitFollower: accelerator boost or crash (see ModuleMGPlayer.defaultObstacleHit). */
export function mgDefaultOnObstacleHit(caller: unknown){
  const miniGame = mgGetMiniGame();
  if(!miniGame){ return; }
  const player = BitWise.InstanceOfObject(caller, ModuleObjectType.ModuleMGPlayer) ? caller as ModuleMGPlayer : miniGame.player;
  player?.defaultObstacleHit(miniGame.context.obstacleHit ?? miniGame.context.followerHit);
}

export function mgDefaultOnDamage(caller: unknown){
  if(mgIsObject(caller)){ (caller as MGObject).defaultOnDamage(); }
}

export function mgDefaultOnDeath(caller: unknown){
  if(mgIsObject(caller)){ (caller as MGObject).defaultOnDeath(); }
}

export function mgSetHitPoints(object: unknown, hitPoints: number){
  const miniGame = mgGetMiniGame();
  if(!miniGame || !mgIsObject(object)){ return; }
  miniGame.adjustHitPoints(object as unknown as IMiniGameCombatant, hitPoints, true);
}

type SoundSlot = { frequency: number; frequencyIsRandom: number; volume: number };

/** Per-object minigame sound settings (no audio is driven by them yet). Volume defaults to full (127). */
function mgSoundSlot(object: unknown, index: number): SoundSlot | undefined {
  if(!mgIsObject(object)){ return undefined; }
  const slots: SoundSlot[] = (object as any).mgSounds ??= [];
  return slots[index] ??= { frequency: 0, frequencyIsRandom: 0, volume: 127 };
}

export const SWMG_GetLastEvent = defineAction({
  id: 583,
  name: "SWMG_GetLastEvent",
  comment: "583: Returns the name of the last minigame event (the running handler's event, or the model animation event in OnAnimEvent).",
  returnType: NWScriptDataType.STRING,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.context.event ?? "";
  },
});

export const SWMG_GetLastEventModelName = defineAction({
  id: 584,
  name: "SWMG_GetLastEventModelName",
  comment: "584: Returns the name of the model associated with the last minigame event.",
  returnType: NWScriptDataType.STRING,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.context.modelName ?? "";
  },
});

export const SWMG_GetObjectByName = defineAction({
  id: 585,
  name: "SWMG_GetObjectByName",
  comment: "585: Get a minigame object (player, follower or obstacle) by its name.",
  returnType: NWScriptDataType.OBJECT,
  params: [stringParam("sName")] as const,
  kotor(this: NWScriptInstance, sName) {
    return mgGetMiniGame()?.getObjectByName(sName);
  },
});

export const SWMG_PlayAnimation = defineAction({
  id: 586,
  name: "SWMG_PlayAnimation",
  comment: "586: Play an animation on a minigame object.",
  returnType: NWScriptDataType.VOID,
  params: [
    objectParam<ModuleObject>("oObject"),
    stringParam("sAnimName"),
    intParam("bLooping", { optional: true, default: 1 }),
    intParam("bQueue", { optional: true, default: 0 }),
    intParam("bOverlay", { optional: true, default: 0 }),
  ] as const,
  kotor(this: NWScriptInstance, oObject, sAnimName, bLooping, bQueue, bOverlay) {
    if (
      BitWise.InstanceOfObject(oObject, ModuleObjectType.ModuleMGPlayer) ||
      BitWise.InstanceOfObject(oObject, ModuleObjectType.ModuleMGEnemy)
    ) {
      (oObject as ModuleMGPlayer | ModuleMGEnemy).playAnimation(sAnimName, bLooping, bQueue, bOverlay);
    }
  },
});

export const SWMG_GetLastBulletHitDamage = defineAction({
  id: 587,
  name: "SWMG_GetLastBulletHitDamage",
  comment: "587: OnHitBullet: the damage of the bullet.",
  returnType: NWScriptDataType.INTEGER,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.context.bulletHitDamage ?? 0;
  },
});

export const SWMG_GetLastBulletHitTarget = defineAction({
  id: 588,
  name: "SWMG_GetLastBulletHitTarget",
  comment: "588: OnHitBullet: the target type of the bullet.",
  returnType: NWScriptDataType.INTEGER,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.context.bulletHitTarget ?? 0;
  },
});

export const SWMG_GetLastBulletHitShooter = defineAction({
  id: 589,
  name: "SWMG_GetLastBulletHitShooter",
  comment: "589: OnHitBullet: the object that fired the bullet.",
  returnType: NWScriptDataType.OBJECT,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.context.bulletHitShooter;
  },
});

export const SWMG_AdjustFollowerHitPoints = defineAction({
  id: 590,
  name: "SWMG_AdjustFollowerHitPoints",
  comment: "590: Adjusts a follower's hit points (or sets them when nAbsolute is TRUE). Returns the new hit points.",
  returnType: NWScriptDataType.INTEGER,
  params: [
    objectParam<ModuleObject>("oFollower"),
    intParam("nHP"),
    intParam("nAbsolute", { optional: true, default: 0 }),
  ] as const,
  kotor(this: NWScriptInstance, oFollower, nHP, nAbsolute) {
    const miniGame = mgGetMiniGame();
    if (!miniGame || !mgIsObject(oFollower)) return 0;
    return miniGame.adjustHitPoints(oFollower as unknown as IMiniGameCombatant, nHP, !!nAbsolute);
  },
});

export const SWMG_OnBulletHit = defineAction({
  id: 591,
  name: "SWMG_OnBulletHit",
  comment: "591: The default implementation of OnBulletHit: OBJECT_SELF takes the bullet's damage.",
  returnType: NWScriptDataType.VOID,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    mgDefaultOnBulletHit(this.caller);
  },
});

export const SWMG_OnObstacleHit = defineAction({
  id: 592,
  name: "SWMG_OnObstacleHit",
  comment: "592: The default implementation of OnObstacleHit.",
  returnType: NWScriptDataType.VOID,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    mgDefaultOnObstacleHit(this.caller);
  },
});

export const SWMG_GetLastFollowerHit = defineAction({
  id: 593,
  name: "SWMG_GetLastFollowerHit",
  comment: "593: Returns the last follower hit.",
  returnType: NWScriptDataType.OBJECT,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.context.followerHit ?? this.mgFollower ?? undefined;
  },
});

export const SWMG_GetLastObstacleHit = defineAction({
  id: 594,
  name: "SWMG_GetLastObstacleHit",
  comment: "594: Returns the last obstacle hit.",
  returnType: NWScriptDataType.OBJECT,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.context.obstacleHit ?? this.mgObstacle ?? undefined;
  },
});

export const SWMG_GetLastBulletFiredDamage = defineAction({
  id: 595,
  name: "SWMG_GetLastBulletFiredDamage",
  comment: "595: OnFire: the damage of the bullet just fired.",
  returnType: NWScriptDataType.INTEGER,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.context.bulletFiredDamage ?? 0;
  },
});

export const SWMG_GetLastBulletFiredTarget = defineAction({
  id: 596,
  name: "SWMG_GetLastBulletFiredTarget",
  comment: "596: OnFire: the target type of the bullet just fired.",
  returnType: NWScriptDataType.INTEGER,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.context.bulletFiredTarget ?? 0;
  },
});

export const SWMG_GetObjectName = defineAction({
  id: 597,
  name: "SWMG_GetObjectName",
  comment: "597: Gets an object's name.",
  returnType: NWScriptDataType.STRING,
  params: [objectParam<ModuleObject | undefined>("oid", { optional: true, default: undefined })] as const,
  kotor(this: NWScriptInstance, oid) {
    const object = oid ?? this.caller;
    if (BitWise.InstanceOfObject(object, ModuleObjectType.ModuleObject)) {
      return object.name || "";
    }
    return "";
  },
});

export const SWMG_OnDeath = defineAction({
  id: 598,
  name: "SWMG_OnDeath",
  comment: "598: The default implementation of OnDeath.",
  returnType: NWScriptDataType.VOID,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    mgDefaultOnDeath(this.caller);
  },
});

export const SWMG_IsFollower = defineAction({
  id: 599,
  name: "SWMG_IsFollower",
  comment: "599: Return whether the object is a minigame follower (any track-following enemy or trigger).",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oid")] as const,
  kotor(this: NWScriptInstance, oid) {
    return mgGetMiniGame()?.enemies.includes(oid as ModuleMGEnemy) ? NW_TRUE : NW_FALSE;
  },
});

export const SWMG_IsPlayer = defineAction({
  id: 600,
  name: "SWMG_IsPlayer",
  comment: "600: Return whether the object is the minigame player.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oid")] as const,
  kotor(this: NWScriptInstance, oid) {
    const player = mgPlayer();
    return player && player === oid ? NW_TRUE : NW_FALSE;
  },
});

export const SWMG_IsEnemy = defineAction({
  id: 601,
  name: "SWMG_IsEnemy",
  comment: "601: Return whether the object is a minigame enemy (a follower that is not a trigger).",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oid")] as const,
  kotor(this: NWScriptInstance, oid) {
    const enemy = oid as ModuleMGEnemy;
    return mgGetMiniGame()?.enemies.includes(enemy) && !enemy.trigger ? NW_TRUE : NW_FALSE;
  },
});

export const SWMG_IsTrigger = defineAction({
  id: 602,
  name: "SWMG_IsTrigger",
  comment: "602: Return whether the object is a trigger follower (enemy template Trigger flag).",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oid")] as const,
  kotor(this: NWScriptInstance, oid) {
    const enemy = oid as ModuleMGEnemy;
    return mgGetMiniGame()?.enemies.includes(enemy) && enemy.trigger ? NW_TRUE : NW_FALSE;
  },
});

export const SWMG_IsObstacle = defineAction({
  id: 603,
  name: "SWMG_IsObstacle",
  comment: "603: Return whether the object is a minigame obstacle.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oid")] as const,
  kotor(this: NWScriptInstance, oid) {
    return mgGetMiniGame()?.obstacles.includes(oid as ModuleMGObstacle) ? NW_TRUE : NW_FALSE;
  },
});

export const SWMG_SetFollowerHitPoints = defineAction({
  id: 604,
  name: "SWMG_SetFollowerHitPoints",
  comment: "604: Sets a follower's hit points.",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nHP")] as const,
  kotor(this: NWScriptInstance, oFollower, nHP) {
    mgSetHitPoints(oFollower, nHP);
  },
});

export const SWMG_OnDamage = defineAction({
  id: 605,
  name: "SWMG_OnDamage",
  comment: "605: The default implementation of OnDamage.",
  returnType: NWScriptDataType.VOID,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    mgDefaultOnDamage(this.caller);
  },
});

export const SWMG_GetLastHPChange = defineAction({
  id: 606,
  name: "SWMG_GetLastHPChange",
  comment: "606: The hit point change behind the current OnDamage (negative for damage).",
  returnType: NWScriptDataType.INTEGER,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.context.hpChange ?? 0;
  },
});

export const SWMG_RemoveAnimation = defineAction({
  id: 607,
  name: "SWMG_RemoveAnimation",
  comment: "607: Removes an animation from a minigame object.",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oObject"), stringParam("sAnimName")] as const,
  kotor(this: NWScriptInstance, oObject, sAnimName) {
    if (
      BitWise.InstanceOfObject(oObject, ModuleObjectType.ModuleMGPlayer) ||
      BitWise.InstanceOfObject(oObject, ModuleObjectType.ModuleMGEnemy)
    ) {
      (oObject as ModuleMGPlayer | ModuleMGEnemy).removeAnimation(sAnimName);
    }
  },
});

export const SWMG_GetCameraNearClip = defineAction({
  id: 608,
  name: "SWMG_GetCameraNearClip",
  comment: "608: Gets the minigame camera's near clip plane.",
  returnType: NWScriptDataType.FLOAT,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.nearClip ?? 0;
  },
});

export const SWMG_GetCameraFarClip = defineAction({
  id: 609,
  name: "SWMG_GetCameraFarClip",
  comment: "609: Gets the minigame camera's far clip plane.",
  returnType: NWScriptDataType.FLOAT,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.farClip ?? 0;
  },
});

export const SWMG_SetCameraClip = defineAction({
  id: 610,
  name: "SWMG_SetCameraClip",
  comment: "610: Sets the minigame camera's near and far clip planes.",
  returnType: NWScriptDataType.VOID,
  params: [floatParam("fNear"), floatParam("fFar")] as const,
  kotor(this: NWScriptInstance, fNear, fFar) {
    mgGetMiniGame()?.setCameraClip(fNear, fFar);
  },
});

export const SWMG_GetPlayer = defineAction({
  id: 611,
  name: "SWMG_GetPlayer",
  comment: "611: Get the minigame player.",
  returnType: NWScriptDataType.OBJECT,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgPlayer();
  },
});

export const SWMG_GetEnemyCount = defineAction({
  id: 612,
  name: "SWMG_GetEnemyCount",
  comment: "612: Get the number of minigame enemies (followers).",
  returnType: NWScriptDataType.INTEGER,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.enemies.length ?? 0;
  },
});

export const SWMG_GetEnemy = defineAction({
  id: 613,
  name: "SWMG_GetEnemy",
  comment: "613: Get a minigame enemy (follower) by index.",
  returnType: NWScriptDataType.OBJECT,
  params: [intParam("nEntry")] as const,
  kotor(this: NWScriptInstance, nEntry) {
    return mgGetMiniGame()?.enemies[nEntry];
  },
});

export const SWMG_GetObstacleCount = defineAction({
  id: 614,
  name: "SWMG_GetObstacleCount",
  comment: "614: Get the number of minigame obstacles.",
  returnType: NWScriptDataType.INTEGER,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.obstacles.length ?? 0;
  },
});

export const SWMG_GetObstacle = defineAction({
  id: 615,
  name: "SWMG_GetObstacle",
  comment: "615: Get a minigame obstacle by index.",
  returnType: NWScriptDataType.OBJECT,
  params: [intParam("nEntry")] as const,
  kotor(this: NWScriptInstance, nEntry) {
    return mgGetMiniGame()?.obstacles[nEntry];
  },
});

export const SWMG_GetHitPoints = defineAction({
  id: 616,
  name: "SWMG_GetHitPoints",
  comment: "616: Get hit points for a minigame object.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oFollower")] as const,
  kotor(this: NWScriptInstance, oFollower) {
    return mgIsObject(oFollower) ? (oFollower as MGObject).hit_points || 0 : 0;
  },
});

export const SWMG_GetMaxHitPoints = defineAction({
  id: 617,
  name: "SWMG_GetMaxHitPoints",
  comment: "617: Get max hit points for a minigame object.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oFollower")] as const,
  kotor(this: NWScriptInstance, oFollower) {
    return mgIsObject(oFollower) ? (oFollower as MGObject).max_hps || 0 : 0;
  },
});

export const SWMG_SetMaxHitPoints = defineAction({
  id: 618,
  name: "SWMG_SetMaxHitPoints",
  comment: "618: Set max hit points for a minigame object.",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nMaxHP")] as const,
  kotor(this: NWScriptInstance, oFollower, nMaxHP) {
    if (mgIsObject(oFollower)) (oFollower as MGObject).max_hps = nMaxHP;
  },
});

export const SWMG_GetSphereRadius = defineAction({
  id: 619,
  name: "SWMG_GetSphereRadius",
  comment: "619: Get the collision sphere radius of a minigame object.",
  returnType: NWScriptDataType.FLOAT,
  params: [objectParam<ModuleObject>("oFollower")] as const,
  kotor(this: NWScriptInstance, oFollower) {
    return mgIsObject(oFollower) ? (oFollower as MGObject).sphere_radius || 0 : 0;
  },
});

export const SWMG_SetSphereRadius = defineAction({
  id: 620,
  name: "SWMG_SetSphereRadius",
  comment: "620: Set the collision sphere radius of a minigame object.",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oFollower"), floatParam("fRadius")] as const,
  kotor(this: NWScriptInstance, oFollower, fRadius) {
    if (mgIsObject(oFollower)) (oFollower as MGObject).sphere_radius = fRadius;
  },
});

export const SWMG_GetNumLoops = defineAction({
  id: 621,
  name: "SWMG_GetNumLoops",
  comment: "621: Get the number of track loops for a minigame object.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oFollower")] as const,
  kotor(this: NWScriptInstance, oFollower) {
    return mgIsObject(oFollower) ? (oFollower as MGObject).num_loops || 0 : 0;
  },
});

export const SWMG_SetNumLoops = defineAction({
  id: 622,
  name: "SWMG_SetNumLoops",
  comment: "622: Set the number of track loops for a minigame object.",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nNumLoops")] as const,
  kotor(this: NWScriptInstance, oFollower, nNumLoops) {
    if (mgIsObject(oFollower)) (oFollower as MGObject).num_loops = nNumLoops;
  },
});

export const SWMG_GetPosition = defineAction({
  id: 623,
  name: "SWMG_GetPosition",
  comment: "623: Get the world position of a minigame object.",
  returnType: NWScriptDataType.VECTOR,
  params: [objectParam<ModuleObject>("oFollower")] as const,
  kotor(this: NWScriptInstance, oFollower) {
    if (!mgIsObject(oFollower)) return vec();
    return (oFollower as MGObject).getWorldSphere().center.clone();
  },
});

export const SWMG_GetGunBankDamage = defineAction({
  id: 627,
  name: "SWMG_GetGunBankDamage",
  comment: "627: Get the damage of a gun bank's bullets.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nGunBank")] as const,
  kotor(this: NWScriptInstance, oFollower, nGunBank) {
    return mgGunBank(oFollower, nGunBank)?.proto_bullet?.damage_amt ?? 0;
  },
});

export const SWMG_GetGunBankTimeBetweenShots = defineAction({
  id: 628,
  name: "SWMG_GetGunBankTimeBetweenShots",
  comment: "628: Get the time between shots of a gun bank.",
  returnType: NWScriptDataType.FLOAT,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nGunBank")] as const,
  kotor(this: NWScriptInstance, oFollower, nGunBank) {
    return mgGunBank(oFollower, nGunBank)?.proto_bullet?.rate_of_fire ?? 0;
  },
});

export const SWMG_GetGunBankLifespan = defineAction({
  id: 629,
  name: "SWMG_GetGunBankLifespan",
  comment: "629: Get the lifespan of a gun bank's bullets.",
  returnType: NWScriptDataType.FLOAT,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nGunBank")] as const,
  kotor(this: NWScriptInstance, oFollower, nGunBank) {
    return mgGunBank(oFollower, nGunBank)?.proto_bullet?.lifespan ?? 0;
  },
});

export const SWMG_GetGunBankSpeed = defineAction({
  id: 630,
  name: "SWMG_GetGunBankSpeed",
  comment: "630: Get the speed of a gun bank's bullets.",
  returnType: NWScriptDataType.FLOAT,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nGunBank")] as const,
  kotor(this: NWScriptInstance, oFollower, nGunBank) {
    return mgGunBank(oFollower, nGunBank)?.proto_bullet?.speed ?? 0;
  },
});

export const SWMG_GetGunBankTarget = defineAction({
  id: 631,
  name: "SWMG_GetGunBankTarget",
  comment: "631: Get the target type of a gun bank's bullets.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nGunBank")] as const,
  kotor(this: NWScriptInstance, oFollower, nGunBank) {
    return mgGunBank(oFollower, nGunBank)?.proto_bullet?.target_type ?? 0;
  },
});

export const SWMG_SetGunBankDamage = defineAction({
  id: 634,
  name: "SWMG_SetGunBankDamage",
  comment: "634: Set the damage of a gun bank's bullets.",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nGunBank"), intParam("nDamage")] as const,
  kotor(this: NWScriptInstance, oFollower, nGunBank, nDamage) {
    const bullet = mgGunBank(oFollower, nGunBank)?.proto_bullet;
    if (bullet) bullet.damage_amt = nDamage;
  },
});

export const SWMG_SetGunBankTimeBetweenShots = defineAction({
  id: 635,
  name: "SWMG_SetGunBankTimeBetweenShots",
  comment: "635: Set the time between shots of a gun bank.",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nGunBank"), floatParam("fTime")] as const,
  kotor(this: NWScriptInstance, oFollower, nGunBank, fTime) {
    const bullet = mgGunBank(oFollower, nGunBank)?.proto_bullet;
    if (bullet) bullet.rate_of_fire = fTime;
  },
});

export const SWMG_SetGunBankLifespan = defineAction({
  id: 636,
  name: "SWMG_SetGunBankLifespan",
  comment: "636: Set the lifespan of a gun bank's bullets.",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nGunBank"), floatParam("fLifespan")] as const,
  kotor(this: NWScriptInstance, oFollower, nGunBank, fLifespan) {
    const bullet = mgGunBank(oFollower, nGunBank)?.proto_bullet;
    if (bullet) bullet.lifespan = fLifespan;
  },
});

export const SWMG_SetGunBankSpeed = defineAction({
  id: 637,
  name: "SWMG_SetGunBankSpeed",
  comment: "637: Set the speed of a gun bank's bullets.",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nGunBank"), floatParam("fSpeed")] as const,
  kotor(this: NWScriptInstance, oFollower, nGunBank, fSpeed) {
    const bullet = mgGunBank(oFollower, nGunBank)?.proto_bullet;
    if (bullet) bullet.speed = fSpeed;
  },
});

export const SWMG_SetGunBankTarget = defineAction({
  id: 638,
  name: "SWMG_SetGunBankTarget",
  comment: "638: Set the target type of a gun bank's bullets.",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nGunBank"), intParam("nTarget")] as const,
  kotor(this: NWScriptInstance, oFollower, nGunBank, nTarget) {
    const bullet = mgGunBank(oFollower, nGunBank)?.proto_bullet;
    if (bullet) bullet.target_type = nTarget;
  },
});

export const SWMG_GetLastBulletHitPart = defineAction({
  id: 639,
  name: "SWMG_GetLastBulletHitPart",
  comment: "639: OnHitBullet: the model part of the target the bullet hit.",
  returnType: NWScriptDataType.STRING,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgGetMiniGame()?.context.bulletHitPart ?? "";
  },
});

export const SWMG_IsGunBankTargetting = defineAction({
  id: 640,
  name: "SWMG_IsGunBankTargetting",
  comment: "640: Whether a gun bank currently has its target in its line of fire.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nGunBank")] as const,
  kotor(this: NWScriptInstance, oFollower, nGunBank) {
    return mgGunBank(oFollower, nGunBank)?.targetting ? NW_TRUE : NW_FALSE;
  },
});

export const SWMG_GetPlayerOffset = defineAction({
  id: 641,
  name: "SWMG_GetPlayerOffset",
  comment: "641: Turret: the player's rotation in degrees. Swoop: the player's offset from its track.",
  returnType: NWScriptDataType.VECTOR,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    const miniGame = mgGetMiniGame();
    const player = miniGame?.player;
    if (!player) return vec();
    if (miniGame.type === MiniGameType.TURRET) {
      return radiansToDegrees(player.rotation);
    }
    return vec(player.position.x, player.position.y, player.position.z);
  },
});

export const SWMG_GetPlayerInvincibility = defineAction({
  id: 642,
  name: "SWMG_GetPlayerInvincibility",
  comment: "642: Seconds of invulnerability the player has left.",
  returnType: NWScriptDataType.FLOAT,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgPlayer()?.invince ?? 0;
  },
});

export const SWMG_GetPlayerSpeed = defineAction({
  id: 643,
  name: "SWMG_GetPlayerSpeed",
  comment: "643: Get the player character's speed.",
  returnType: NWScriptDataType.FLOAT,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgPlayer()?.speed ?? 0;
  },
});

export const SWMG_GetPlayerMinSpeed = defineAction({
  id: 644,
  name: "SWMG_GetPlayerMinSpeed",
  comment: "644: Get the player character's minimum speed.",
  returnType: NWScriptDataType.FLOAT,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgPlayer()?.speed_min ?? 0;
  },
});

export const SWMG_GetPlayerAccelerationPerSecond = defineAction({
  id: 645,
  name: "SWMG_GetPlayerAccelerationPerSecond",
  comment: "645: Get the player character's acceleration per second.",
  returnType: NWScriptDataType.FLOAT,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgPlayer()?.accel_secs ?? 0;
  },
});

export const SWMG_GetPlayerTunnelPos = defineAction({
  id: 646,
  name: "SWMG_GetPlayerTunnelPos",
  comment: "646: Get the player's positive tunnel limits (degrees).",
  returnType: NWScriptDataType.VECTOR,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    const player = mgPlayer();
    return player ? radiansToDegrees(player.tunnel.pos) : vec();
  },
});

export const SWMG_SetPlayerOffset = defineAction({
  id: 647,
  name: "SWMG_SetPlayerOffset",
  comment: "647: Turret: set the player's rotation in degrees. Swoop: set the player's offset from its track.",
  returnType: NWScriptDataType.VOID,
  params: [vectorParam<Vec>("vOffset")] as const,
  kotor(this: NWScriptInstance, vOffset) {
    const miniGame = mgGetMiniGame();
    const player = miniGame?.player;
    if (!player || !vOffset) return;
    if (miniGame.type === MiniGameType.TURRET) {
      player.rotation.set(
        THREE.MathUtils.degToRad(vOffset.x || 0),
        THREE.MathUtils.degToRad(vOffset.y || 0),
        THREE.MathUtils.degToRad(vOffset.z || 0),
      );
      return;
    }
    player.position.set(vOffset.x || 0, vOffset.y || 0, vOffset.z || 0);
  },
});

export const SWMG_SetPlayerInvincibility = defineAction({
  id: 648,
  name: "SWMG_SetPlayerInvincibility",
  comment: "648: Make the player invulnerable for the given number of seconds.",
  returnType: NWScriptDataType.VOID,
  params: [floatParam("fInvincibility")] as const,
  kotor(this: NWScriptInstance, fInvincibility) {
    const player = mgPlayer();
    if (player) player.invince = Math.max(0, fInvincibility || 0);
  },
});

export const SWMG_SetPlayerSpeed = defineAction({
  id: 649,
  name: "SWMG_SetPlayerSpeed",
  comment: "649: Set the player character's speed.",
  returnType: NWScriptDataType.VOID,
  params: [floatParam("fSpeed")] as const,
  kotor(this: NWScriptInstance, fSpeed) {
    const player = mgPlayer();
    if (player) player.speed = fSpeed;
  },
});

export const SWMG_SetPlayerMinSpeed = defineAction({
  id: 650,
  name: "SWMG_SetPlayerMinSpeed",
  comment: "650: Set the player character's minimum speed.",
  returnType: NWScriptDataType.VOID,
  params: [floatParam("fMinSpeed")] as const,
  kotor(this: NWScriptInstance, fMinSpeed) {
    const player = mgPlayer();
    if (player) player.speed_min = fMinSpeed;
  },
});

export const SWMG_SetPlayerAccelerationPerSecond = defineAction({
  id: 651,
  name: "SWMG_SetPlayerAccelerationPerSecond",
  comment: "651: Set the player character's acceleration per second.",
  returnType: NWScriptDataType.VOID,
  params: [floatParam("fAPS")] as const,
  kotor(this: NWScriptInstance, fAPS) {
    const player = mgPlayer();
    if (player) player.accel_secs = fAPS;
  },
});

export const SWMG_SetPlayerTunnelPos = defineAction({
  id: 652,
  name: "SWMG_SetPlayerTunnelPos",
  comment: "652: Set the player's positive tunnel limits (degrees).",
  returnType: NWScriptDataType.VOID,
  params: [vectorParam<Vec>("vTunnel")] as const,
  kotor(this: NWScriptInstance, vTunnel) {
    const player = mgPlayer();
    if (player) setFromDegrees(player.tunnel.pos, vTunnel);
  },
});

export const SWMG_GetPlayerTunnelNeg = defineAction({
  id: 653,
  name: "SWMG_GetPlayerTunnelNeg",
  comment: "653: Get the player's negative tunnel limits (degrees).",
  returnType: NWScriptDataType.VECTOR,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    const player = mgPlayer();
    return player ? radiansToDegrees(player.tunnel.neg) : vec();
  },
});

export const SWMG_SetPlayerTunnelNeg = defineAction({
  id: 654,
  name: "SWMG_SetPlayerTunnelNeg",
  comment: "654: Set the player's negative tunnel limits (degrees).",
  returnType: NWScriptDataType.VOID,
  params: [vectorParam<Vec>("vTunnel")] as const,
  kotor(this: NWScriptInstance, vTunnel) {
    const player = mgPlayer();
    if (player) setFromDegrees(player.tunnel.neg, vTunnel);
  },
});

export const SWMG_GetPlayerOrigin = defineAction({
  id: 655,
  name: "SWMG_GetPlayerOrigin",
  comment: "655: Get the origin of the player's track.",
  returnType: NWScriptDataType.VECTOR,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    const track = mgPlayer()?.track;
    return track ? vec(track.position.x, track.position.y, track.position.z) : vec();
  },
});

export const SWMG_SetPlayerOrigin = defineAction({
  id: 656,
  name: "SWMG_SetPlayerOrigin",
  comment: "656: Move the origin of the player's track.",
  returnType: NWScriptDataType.VOID,
  params: [vectorParam<Vec>("vOrigin")] as const,
  kotor(this: NWScriptInstance, vOrigin) {
    const track = mgPlayer()?.track;
    if (track && vOrigin) {
      track.position.set(vOrigin.x || 0, vOrigin.y || 0, vOrigin.z || 0);
      track.updateMatrixWorld();
    }
  },
});

export const SWMG_GetIsInvulnerable = defineAction({
  id: 665,
  name: "SWMG_GetIsInvulnerable",
  comment: "665: Return whether the follower object is currently invulnerable.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oFollower")] as const,
  kotor(this: NWScriptInstance, oFollower) {
    return mgIsObject(oFollower) && (oFollower as MGObject).invince > 0 ? NW_TRUE : NW_FALSE;
  },
});

export const SWMG_StartInvulnerability = defineAction({
  id: 666,
  name: "SWMG_StartInvulnerability",
  comment: "666: Begin the object's invulnerability period (its Invince_Period).",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oFollower")] as const,
  kotor(this: NWScriptInstance, oFollower) {
    if (mgIsObject(oFollower)) (oFollower as MGObject).startInvulnerability();
  },
});

export const SWMG_GetPlayerMaxSpeed = defineAction({
  id: 667,
  name: "SWMG_GetPlayerMaxSpeed",
  comment: "667: GetPlayerMaxSpeed - Returns the player character's max speed.",
  returnType: NWScriptDataType.FLOAT,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    return mgPlayer()?.speed_max ?? 0;
  },
});

export const SWMG_SetPlayerMaxSpeed = defineAction({
  id: 668,
  name: "SWMG_SetPlayerMaxSpeed",
  comment: "668: SetPlayerMaxSpeed - Sets the player character's max speed.",
  returnType: NWScriptDataType.VOID,
  params: [floatParam("fMaxSpeed")] as const,
  kotor(this: NWScriptInstance, fMaxSpeed) {
    const player = mgPlayer();
    if (player) player.speed_max = fMaxSpeed;
  },
});

export const SWMG_GetSoundFrequency = defineAction({
  id: 683,
  name: "SWMG_GetSoundFrequency",
  comment: "683: Gets the frequency of a minigame object's sound.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nSound")] as const,
  kotor(this: NWScriptInstance, oFollower, nSound) {
    return mgSoundSlot(oFollower, nSound)?.frequency ?? 0;
  },
});

export const SWMG_SetSoundFrequency = defineAction({
  id: 684,
  name: "SWMG_SetSoundFrequency",
  comment: "684: Sets the frequency of a minigame object's sound.",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nSound"), intParam("nFrequency")] as const,
  kotor(this: NWScriptInstance, oFollower, nSound, nFrequency) {
    const slot = mgSoundSlot(oFollower, nSound);
    if (slot) slot.frequency = nFrequency;
  },
});

export const SWMG_GetSoundFrequencyIsRandom = defineAction({
  id: 685,
  name: "SWMG_GetSoundFrequencyIsRandom",
  comment: "685: Whether a minigame object's sound frequency is randomized.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nSound")] as const,
  kotor(this: NWScriptInstance, oFollower, nSound) {
    return mgSoundSlot(oFollower, nSound)?.frequencyIsRandom ? NW_TRUE : NW_FALSE;
  },
});

export const SWMG_SetSoundFrequencyIsRandom = defineAction({
  id: 686,
  name: "SWMG_SetSoundFrequencyIsRandom",
  comment: "686: Sets whether a minigame object's sound frequency is randomized.",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nSound"), intParam("bIsRandom")] as const,
  kotor(this: NWScriptInstance, oFollower, nSound, bIsRandom) {
    const slot = mgSoundSlot(oFollower, nSound);
    if (slot) slot.frequencyIsRandom = bIsRandom ? NW_TRUE : NW_FALSE;
  },
});

export const SWMG_GetSoundVolume = defineAction({
  id: 687,
  name: "SWMG_GetSoundVolume",
  comment: "687: Gets the volume of a minigame object's sound.",
  returnType: NWScriptDataType.INTEGER,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nSound")] as const,
  kotor(this: NWScriptInstance, oFollower, nSound) {
    return mgSoundSlot(oFollower, nSound)?.volume ?? 0;
  },
});

export const SWMG_SetSoundVolume = defineAction({
  id: 688,
  name: "SWMG_SetSoundVolume",
  comment: "688: Sets the volume of a minigame object's sound.",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oFollower"), intParam("nSound"), intParam("nVolume")] as const,
  kotor(this: NWScriptInstance, oFollower, nSound, nVolume) {
    const slot = mgSoundSlot(oFollower, nSound);
    if (slot) slot.volume = nVolume;
  },
});

export const SWMG_GetPlayerTunnelInfinite = defineAction({
  id: 717,
  name: "SWMG_GetPlayerTunnelInfinite",
  comment: "717: Gets the player's per-axis infinite-tunnel flags.",
  returnType: NWScriptDataType.VECTOR,
  params: [] as const,
  kotor(this: NWScriptInstance) {
    const infinite = mgPlayer()?.tunnelInfinite;
    return infinite ? vec(infinite.x, infinite.y, infinite.z) : vec();
  },
});

export const SWMG_SetPlayerTunnelInfinite = defineAction({
  id: 718,
  name: "SWMG_SetPlayerTunnelInfinite",
  comment: "718: Sets the player's per-axis infinite-tunnel flags.",
  returnType: NWScriptDataType.VOID,
  params: [vectorParam<Vec>("vInfinite")] as const,
  kotor(this: NWScriptInstance, vInfinite) {
    const player = mgPlayer();
    if (player && vInfinite) player.tunnelInfinite = { x: vInfinite.x || 0, y: vInfinite.y || 0, z: vInfinite.z || 0 };
  },
});

export const SWMG_SetSpeedBlurEffect = defineAction({
  id: 563,
  name: "SWMG_SetSpeedBlurEffect",
  comment:
    "563: Turns on or off the speed blur effect in rendered scenes.\n" +
    "bEnabled: Set TRUE to turn it on, FALSE to turn it off.\n" +
    "fRatio: Sets the frame accumulation ratio.",
  returnType: NWScriptDataType.VOID,
  params: [intParam("bEnabled"), floatParam("fRatio")] as const,
  kotor(this: NWScriptInstance, bEnabled, fRatio) {
    // Preserved legacy behavior: old implementation was a TODO/no-op.
  },
});

export const SWMG_GetSwoopUpgrade = defineAction({
  availability: "tsl",
  id: 782,
  name: "SWMG_GetSwoopUpgrade",
  comment: "782: Minigame grabs a swoop bike upgrade.",
  returnType: NWScriptDataType.INTEGER,
  params: [intParam("nIndex")] as const,
  tsl(this: NWScriptInstance, nIndex) {
    switch (nIndex) {
      case 0:
        return GameState.PartyManager.SwoopUpgrade1;
      case 1:
        return GameState.PartyManager.SwoopUpgrade2;
      case 2:
        return GameState.PartyManager.SwoopUpgrade3;
      default:
        return -1;
    }
  },
});

export const ShowSwoopUpgradeScreen = defineAction({
  availability: "tsl",
  id: 785,
  name: "ShowSwoopUpgradeScreen",
  comment: "785: Displays the Swoop Bike upgrade screen.",
  returnType: NWScriptDataType.VOID,
  params: [] as const,
  tsl(this: NWScriptInstance) {
    GameState.MenuManager.MenuSwoopUp?.open();
  },
});

export const SWMG_GetTrackPosition = defineAction({
  availability: "tsl",
  id: 789,
  name: "SWMG_GetTrackPosition",
  comment: "789: Gets the world position of a follower's (or the player's) track.",
  returnType: NWScriptDataType.VECTOR,
  params: [objectParam<ModuleObject>("oFollower")] as const,
  tsl(this: NWScriptInstance, oFollower) {
    const track = mgIsObject(oFollower) ? (oFollower as any).track as THREE.Object3D | undefined : undefined;
    if (!track) return vec();
    return track.getWorldPosition(new THREE.Vector3());
  },
});

export const SWMG_SetFollowerPosition = defineAction({
  availability: "tsl",
  id: 790,
  name: "SWMG_SetFollowerPosition",
  comment: "790: Sets OBJECT_SELF's offset on its track; returns its new world position.",
  returnType: NWScriptDataType.VECTOR,
  params: [vectorParam<Vec>("vPos")] as const,
  tsl(this: NWScriptInstance, vPos) {
    const follower = this.caller;
    if (!mgIsObject(follower) || !vPos) return vec();
    (follower as MGObject).position.set(vPos.x || 0, vPos.y || 0, vPos.z || 0);
    return (follower as MGObject).getWorldSphere().center.clone();
  },
});

export const SWMG_DestroyMiniGameObject = defineAction({
  availability: "tsl",
  id: 792,
  name: "SWMG_DestroyMiniGameObject",
  comment: "792: Removes a follower or obstacle from the minigame.",
  returnType: NWScriptDataType.VOID,
  params: [objectParam<ModuleObject>("oObject")] as const,
  tsl(this: NWScriptInstance, oObject) {
    mgGetMiniGame()?.destroyObject(oObject);
  },
});

export const SWMG_SetJumpSpeed = defineAction({
  availability: "tsl",
  id: 804,
  name: "SWMG_SetJumpSpeed",
  comment: "804: Sets the swoop player's jump speed (0 disables jumping).",
  returnType: NWScriptDataType.VOID,
  params: [floatParam("fSpeed")] as const,
  tsl(this: NWScriptInstance, fSpeed) {
    const player = mgPlayer();
    if (player) player.jumpSpeed = Math.max(0, fSpeed || 0);
  },
});

export const SWMG_PlayerApplyForce = defineAction({
  availability: "tsl",
  id: 825,
  name: "SWMG_PlayerApplyForce",
  comment: "825: Pushes the swoop player by the given vector on its next update.",
  returnType: NWScriptDataType.VOID,
  params: [vectorParam<Vec>("vForce")] as const,
  tsl(this: NWScriptInstance, vForce) {
    mgPlayer()?.applyForce(vForce);
  },
});

export const minigameActions = [
  SWMG_GetLastEvent,
  SWMG_GetLastEventModelName,
  SWMG_GetObjectByName,
  SWMG_PlayAnimation,
  SWMG_GetLastBulletHitDamage,
  SWMG_GetLastBulletHitTarget,
  SWMG_GetLastBulletHitShooter,
  SWMG_AdjustFollowerHitPoints,
  SWMG_OnBulletHit,
  SWMG_OnObstacleHit,
  SWMG_GetLastFollowerHit,
  SWMG_GetLastObstacleHit,
  SWMG_GetLastBulletFiredDamage,
  SWMG_GetLastBulletFiredTarget,
  SWMG_GetObjectName,
  SWMG_OnDeath,
  SWMG_IsFollower,
  SWMG_IsPlayer,
  SWMG_IsEnemy,
  SWMG_IsTrigger,
  SWMG_IsObstacle,
  SWMG_SetFollowerHitPoints,
  SWMG_OnDamage,
  SWMG_GetLastHPChange,
  SWMG_RemoveAnimation,
  SWMG_GetCameraNearClip,
  SWMG_GetCameraFarClip,
  SWMG_SetCameraClip,
  SWMG_GetPlayer,
  SWMG_GetEnemyCount,
  SWMG_GetEnemy,
  SWMG_GetObstacleCount,
  SWMG_GetObstacle,
  SWMG_GetHitPoints,
  SWMG_GetMaxHitPoints,
  SWMG_SetMaxHitPoints,
  SWMG_GetSphereRadius,
  SWMG_SetSphereRadius,
  SWMG_GetNumLoops,
  SWMG_SetNumLoops,
  SWMG_GetPosition,
  SWMG_GetGunBankDamage,
  SWMG_GetGunBankTimeBetweenShots,
  SWMG_GetGunBankLifespan,
  SWMG_GetGunBankSpeed,
  SWMG_GetGunBankTarget,
  SWMG_SetGunBankDamage,
  SWMG_SetGunBankTimeBetweenShots,
  SWMG_SetGunBankLifespan,
  SWMG_SetGunBankSpeed,
  SWMG_SetGunBankTarget,
  SWMG_GetLastBulletHitPart,
  SWMG_IsGunBankTargetting,
  SWMG_GetPlayerOffset,
  SWMG_GetPlayerInvincibility,
  SWMG_GetPlayerSpeed,
  SWMG_GetPlayerMinSpeed,
  SWMG_GetPlayerAccelerationPerSecond,
  SWMG_GetPlayerTunnelPos,
  SWMG_SetPlayerOffset,
  SWMG_SetPlayerInvincibility,
  SWMG_SetPlayerSpeed,
  SWMG_SetPlayerMinSpeed,
  SWMG_SetPlayerAccelerationPerSecond,
  SWMG_SetPlayerTunnelPos,
  SWMG_GetPlayerTunnelNeg,
  SWMG_SetPlayerTunnelNeg,
  SWMG_GetPlayerOrigin,
  SWMG_SetPlayerOrigin,
  SWMG_GetIsInvulnerable,
  SWMG_StartInvulnerability,
  SWMG_GetPlayerMaxSpeed,
  SWMG_SetPlayerMaxSpeed,
  SWMG_GetSoundFrequency,
  SWMG_SetSoundFrequency,
  SWMG_GetSoundFrequencyIsRandom,
  SWMG_SetSoundFrequencyIsRandom,
  SWMG_GetSoundVolume,
  SWMG_SetSoundVolume,
  SWMG_GetPlayerTunnelInfinite,
  SWMG_SetPlayerTunnelInfinite,
  SWMG_SetSpeedBlurEffect,
  SWMG_GetSwoopUpgrade,
  ShowSwoopUpgradeScreen,
  SWMG_GetTrackPosition,
  SWMG_SetFollowerPosition,
  SWMG_DestroyMiniGameObject,
  SWMG_SetJumpSpeed,
  SWMG_PlayerApplyForce,
] as const;
