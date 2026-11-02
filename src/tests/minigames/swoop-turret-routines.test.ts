import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import * as THREE from "three";

jest.mock("@/GameState", () => ({ GameState: {} }));
jest.mock("@/utility/GameFileSystem", () => ({ GameFileSystem: {} }));
jest.mock("@/loaders/ResourceLoader", () => ({ ResourceLoader: {} }));
jest.mock("@/loaders", () => ({
  MDLLoader: { loader: { load: () => Promise.reject(new Error("no game assets in tests")) } },
  ResourceLoader: {},
}));
jest.mock("@/odyssey", () => ({
  OdysseyModel: class {}, OdysseyModelAnimation: class {}, OdysseyWalkMesh: class {}, OdysseyModelAnimationManager: class {},
}));
jest.mock("@/three/odyssey", () => {
  const T = jest.requireActual("three") as typeof THREE;
  return { OdysseyModel3D: class extends T.Object3D {}, OdysseyObject3D: class extends T.Object3D {}, OdysseyLightsaberEffect: class {} };
});
jest.mock("@/nwscript/NWScript", () => ({ NWScript: class {} }));
jest.mock("@/nwscript/NWScriptInstance", () => ({ NWScriptInstance: class {} }));
jest.mock("@/nwscript/events", () => ({ NWScriptEvent: class {} }));
jest.mock("@/engine/CollisionManager", () => ({ CollisionManager: class {} }));
jest.mock("@/combat", () => ({ CombatRound: class {}, CombatRoundAction: class {} }));

import { GameState } from "@/GameState";
import { ModuleMiniGame } from "@/module/ModuleMiniGame";
import { ModuleMGObstacle } from "@/module/ModuleMGObstacle";
import { harness } from "../nwscript/routineHarness";
import { bulletBank, fakeScript, makeTrack, miniGameStruct } from "./minigameFixture";

type Engine = "kotor" | "tsl";
const ENGINES: Engine[] = ["kotor", "tsl"];

let runtime: ReturnType<typeof harness>;
let isFallback: (action: unknown) => boolean;
beforeAll(() => {
  runtime = harness();
  isFallback = runtime.loadScript("engineRoutineFallbacks").isEngineRoutineFallback;
});

/** Make the minigame the current area's, for the engine objects and for the routine tables. */
function installMiniGame(mg: ModuleMiniGame) {
  const module = { area: { miniGame: mg, rooms: [] as unknown[] }, readyToProcessEvents: true };
  (GameState as any).module = module;
  runtime.gameState.module = module;
}

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

/** Look a routine up by name in the reconciled table, so a renumbered/missing entry fails loudly. */
function action(engine: Engine, name: string) {
  const table = runtime[engine];
  const id = Object.keys(table).map(Number).find((key) => table[key].name === name);
  if (id === undefined) throw new Error(`${engine} has no routine ${name}`);
  return table[id];
}

function call(engine: Engine, name: string, caller: unknown, ...args: unknown[]) {
  return action(engine, name).action.call({ caller }, args);
}

function buildGame(type: number) {
  const mg = new ModuleMiniGame(miniGameStruct(type, {
    Sphere_Radius: 1.5, Hit_Points: 20, Max_HPs: 25, Minimum_Speed: 4, Maximum_Speed: 40, Accel_Secs: 8,
    Invince_Period: 1.5, Num_Loops: 3, TunnelXNeg: -30, TunnelXPos: 45, TunnelYNeg: 0, TunnelYPos: 0, TunnelZNeg: -10, TunnelZPos: 20,
    TunnelInfinite: { x: 1, y: 0, z: 1 },
    Gun_Banks: [bulletBank({ Bullet_Model: "mgt_bolt", Damage: 7, Lifespan: 2.5, Rate_Of_Fire: 0.3, Speed: 60, Target_Type: 2 }, { Gun_Model: "mgt_gun", Sensing_Radius: 80, Horiz_Spread: 1.5 })],
  }, [
    { Track: "trk_1", Sphere_Radius: 2, Hit_Points: 9, Max_HPs: 9, Num_Loops: 1, Models: [{ Model: "mgs_enemy01", RotatingModel: 0 }],
      Gun_Banks: [bulletBank({ Damage: 2, Lifespan: 1, Rate_Of_Fire: 1, Speed: 30 })] },
    { Track: "trk_2", Trigger: 1, Sphere_Radius: 1, Models: [{ Model: "mgs_accel01", RotatingModel: 0 }] },
  ]));
  mg.player.initProperties();
  for (const bank of mg.player.gunBanks) bank.initProperties();
  mg.player.setTrack(makeTrack(0, 5, 0) as any);
  for (const enemy of mg.enemies) {
    enemy.initProperties();
    for (const bank of enemy.gunBanks) bank.initProperties();
  }
  mg.enemies[0].setTrack(makeTrack(3, 30, 0));
  const obstacle = new ModuleMGObstacle(undefined, { name: "mgs_rock01", position: new THREE.Vector3(2, 50, 1) });
  obstacle.miniGame = mg;
  obstacle.name = "mgs_rock01";
  mg.obstacles.push(obstacle);
  installMiniGame(mg);
  (GameState as any).camera = undefined;
  return { mg, player: mg.player, enemy: mg.enemies[0], trigger: mg.enemies[1], obstacle };
}

/** Every SWMG routine named in the brief's inventory (K1 40 + TSL 5 that were metadata fallbacks). */
const PREVIOUSLY_FALLBACK = [
  "SWMG_GetLastEvent", "SWMG_GetLastEventModelName", "SWMG_GetLastBulletHitDamage", "SWMG_GetLastBulletHitTarget",
  "SWMG_GetLastBulletHitShooter", "SWMG_GetLastBulletFiredDamage", "SWMG_GetLastBulletFiredTarget", "SWMG_GetLastHPChange",
  "SWMG_GetCameraNearClip", "SWMG_GetCameraFarClip", "SWMG_SetCameraClip", "SWMG_SetMaxHitPoints", "SWMG_GetSphereRadius",
  "SWMG_SetSphereRadius", "SWMG_GetNumLoops", "SWMG_SetNumLoops", "SWMG_GetGunBankDamage", "SWMG_GetGunBankTimeBetweenShots",
  "SWMG_GetGunBankLifespan", "SWMG_GetGunBankSpeed", "SWMG_GetGunBankTarget", "SWMG_SetGunBankDamage",
  "SWMG_SetGunBankTimeBetweenShots", "SWMG_SetGunBankLifespan", "SWMG_SetGunBankSpeed", "SWMG_SetGunBankTarget",
  "SWMG_GetLastBulletHitPart", "SWMG_IsGunBankTargetting", "SWMG_GetPlayerInvincibility", "SWMG_SetPlayerInvincibility",
  "SWMG_GetPlayerOrigin", "SWMG_SetPlayerOrigin", "SWMG_GetSoundFrequency", "SWMG_SetSoundFrequency",
  "SWMG_GetSoundFrequencyIsRandom", "SWMG_SetSoundFrequencyIsRandom", "SWMG_GetSoundVolume", "SWMG_SetSoundVolume",
  "SWMG_GetPlayerTunnelInfinite", "SWMG_SetPlayerTunnelInfinite",
];
const TSL_ONLY = ["SWMG_GetTrackPosition", "SWMG_SetFollowerPosition", "SWMG_DestroyMiniGameObject", "SWMG_SetJumpSpeed", "SWMG_PlayerApplyForce"];

describe("SWMG routine coverage in the reconciled action maps", () => {
  test.each(ENGINES)("%s: no SWMG routine is a diagnostic fallback any more", (engine) => {
    const table = runtime[engine];
    const swmg = Object.keys(table).map(Number).filter((id) => /^SWMG_/.test(table[id].name));
    expect(swmg.length).toBe(engine === "kotor" ? 97 : 103);
    expect(swmg.filter((id) => isFallback(table[id])).map((id) => table[id].name)).toEqual([]);
    for (const name of PREVIOUSLY_FALLBACK) expect(isFallback(action(engine, name))).toBe(false);
    for (const name of TSL_ONLY) {
      if (engine === "tsl") expect(isFallback(action(engine, name))).toBe(false);
      else expect(() => action(engine, name)).toThrow();
    }
  });
});

describe.each(ENGINES)("%s SWMG routine values", (engine) => {
  test("object queries: lookup by name/index, kind predicates, names, positions", () => {
    const { mg, player, enemy, trigger, obstacle } = buildGame(1);
    expect(call(engine, "SWMG_GetObjectByName", undefined, "MGS_ENEMY01")).toBe(enemy);
    expect(call(engine, "SWMG_GetObjectByName", undefined, "mgs_rock01")).toBe(obstacle);
    expect(call(engine, "SWMG_GetObjectByName", undefined, "nobody")).toBeUndefined();
    expect(call(engine, "SWMG_GetPlayer", undefined)).toBe(player);
    expect(call(engine, "SWMG_GetEnemyCount", undefined)).toBe(2);
    expect(call(engine, "SWMG_GetEnemy", undefined, 1)).toBe(trigger);
    expect(call(engine, "SWMG_GetObstacleCount", undefined)).toBe(1);
    expect(call(engine, "SWMG_GetObstacle", undefined, 0)).toBe(obstacle);
    expect([enemy, trigger, player, obstacle].map((o) => call(engine, "SWMG_IsFollower", undefined, o))).toEqual([1, 1, 0, 0]);
    expect([enemy, trigger, player, obstacle].map((o) => call(engine, "SWMG_IsEnemy", undefined, o))).toEqual([1, 0, 0, 0]);
    expect([enemy, trigger, player, obstacle].map((o) => call(engine, "SWMG_IsTrigger", undefined, o))).toEqual([0, 1, 0, 0]);
    expect([enemy, trigger, player, obstacle].map((o) => call(engine, "SWMG_IsPlayer", undefined, o))).toEqual([0, 0, 1, 0]);
    expect([enemy, trigger, player, obstacle].map((o) => call(engine, "SWMG_IsObstacle", undefined, o))).toEqual([0, 0, 0, 1]);
    expect(call(engine, "SWMG_GetObjectName", undefined, enemy)).toBe("mgs_enemy01");
    expect(call(engine, "SWMG_GetObjectName", obstacle)).toBe("mgs_rock01"); // OBJECT_SELF default
    const pos = (o: unknown) => { const v = call(engine, "SWMG_GetPosition", undefined, o); return [v.x, v.y, v.z]; };
    expect(pos(enemy)).toEqual([3, 30, 0]);
    expect(pos(player)).toEqual([0, 5, 0]);
    expect(pos(obstacle)).toEqual([2, 50, 1]);
    expect(mg).toBeDefined();
  });

  test("hit points, sphere radius, loops, invulnerability", () => {
    const { player, enemy, obstacle } = buildGame(2);
    expect([player, enemy].map((o) => call(engine, "SWMG_GetHitPoints", undefined, o))).toEqual([20, 9]);
    expect(call(engine, "SWMG_GetMaxHitPoints", undefined, player)).toBe(25);
    call(engine, "SWMG_SetMaxHitPoints", undefined, enemy, 40);
    expect(call(engine, "SWMG_GetMaxHitPoints", undefined, enemy)).toBe(40);
    expect(call(engine, "SWMG_AdjustFollowerHitPoints", undefined, enemy, -4, 0)).toBe(5);
    expect(call(engine, "SWMG_AdjustFollowerHitPoints", undefined, enemy, 12, 1)).toBe(12);
    call(engine, "SWMG_SetFollowerHitPoints", undefined, enemy, 3);
    expect(enemy.hit_points).toBe(3);
    const deaths = fakeScript();
    enemy.scripts.OnDeath = deaths as any;
    call(engine, "SWMG_SetFollowerHitPoints", undefined, enemy, 0);
    expect([enemy.alive, deaths.calls]).toEqual([false, 1]);
    expect([player, enemy, obstacle].map((o) => call(engine, "SWMG_GetSphereRadius", undefined, o))).toEqual([1.5, 2, 1]);
    call(engine, "SWMG_SetSphereRadius", undefined, obstacle, 4.5);
    expect(obstacle.getWorldSphere().radius).toBe(4.5);
    expect([player, enemy].map((o) => call(engine, "SWMG_GetNumLoops", undefined, o))).toEqual([3, 1]);
    call(engine, "SWMG_SetNumLoops", undefined, player, 5);
    expect(player.num_loops).toBe(5);
    expect(call(engine, "SWMG_GetIsInvulnerable", undefined, player)).toBe(0);
    call(engine, "SWMG_StartInvulnerability", undefined, player);
    expect(call(engine, "SWMG_GetIsInvulnerable", undefined, player)).toBe(1);
    expect(call(engine, "SWMG_GetPlayerInvincibility", undefined)).toBe(1.5);
    call(engine, "SWMG_SetPlayerInvincibility", undefined, 4);
    expect(player.invince).toBe(4);
  });

  test("player movement settings: speeds, acceleration, tunnel (degrees), offset, origin, infinite tunnel", () => {
    const { mg, player } = buildGame(1);
    expect(call(engine, "SWMG_GetPlayerSpeed", undefined)).toBe(0);
    call(engine, "SWMG_SetPlayerSpeed", undefined, 12);
    call(engine, "SWMG_SetPlayerMinSpeed", undefined, 6);
    call(engine, "SWMG_SetPlayerMaxSpeed", undefined, 60);
    call(engine, "SWMG_SetPlayerAccelerationPerSecond", undefined, 9);
    expect([
      call(engine, "SWMG_GetPlayerSpeed", undefined), call(engine, "SWMG_GetPlayerMinSpeed", undefined),
      call(engine, "SWMG_GetPlayerMaxSpeed", undefined), call(engine, "SWMG_GetPlayerAccelerationPerSecond", undefined),
    ]).toEqual([12, 6, 60, 9]);
    const v = (r: any) => [r.x, r.y, r.z].map((n: number) => Math.round(n * 1e6) / 1e6);
    expect(v(call(engine, "SWMG_GetPlayerTunnelPos", undefined))).toEqual([45, 0, 20]);
    expect(v(call(engine, "SWMG_GetPlayerTunnelNeg", undefined))).toEqual([-30, 0, -10]);
    const pos = { x: 10, y: 0, z: 90 };
    call(engine, "SWMG_SetPlayerTunnelPos", undefined, pos);
    pos.x = 999; // the routine must copy, not alias, the script vector
    expect(v(call(engine, "SWMG_GetPlayerTunnelPos", undefined))).toEqual([10, 0, 90]);
    expect(player.tunnel.pos.z).toBeCloseTo(Math.PI / 2);
    call(engine, "SWMG_SetPlayerTunnelNeg", undefined, { x: -5, y: -6, z: -7 });
    expect(v(call(engine, "SWMG_GetPlayerTunnelNeg", undefined))).toEqual([-5, -6, -7]);
    call(engine, "SWMG_SetPlayerOffset", undefined, { x: 1, y: 0, z: 0.5 });
    expect(v(call(engine, "SWMG_GetPlayerOffset", undefined))).toEqual([1, 0, 0.5]);
    expect(v(call(engine, "SWMG_GetPlayerOrigin", undefined))).toEqual([0, 5, 0]);
    call(engine, "SWMG_SetPlayerOrigin", undefined, { x: 0, y: 100, z: 2 });
    expect(v(call(engine, "SWMG_GetPlayerOrigin", undefined))).toEqual([0, 100, 2]);
    expect(v(call(engine, "SWMG_GetPosition", undefined, player))).toEqual([1, 100, 2.5]);
    expect(v(call(engine, "SWMG_GetPlayerTunnelInfinite", undefined))).toEqual([1, 0, 1]);
    call(engine, "SWMG_SetPlayerTunnelInfinite", undefined, { x: 0, y: 1, z: 0 });
    expect(v(call(engine, "SWMG_GetPlayerTunnelInfinite", undefined))).toEqual([0, 1, 0]);
    expect(mg.type).toBe(1);
  });

  test("turret offset is the player's rotation in degrees", () => {
    const { player } = buildGame(2);
    call(engine, "SWMG_SetPlayerOffset", undefined, { x: 30, y: 0, z: -45 });
    expect(player.rotation.x).toBeCloseTo(Math.PI / 6);
    const r = call(engine, "SWMG_GetPlayerOffset", undefined);
    expect([r.x, r.y, r.z].map((n: number) => Math.round(n))).toEqual([30, 0, -45]);
  });

  test("gun bank stats read from and write to the bullets the bank fires", () => {
    const { player, enemy } = buildGame(2);
    expect(call(engine, "SWMG_GetGunBankCount", undefined, player)).toBe(1);
    expect(call(engine, "SWMG_GetGunBankBulletModel", undefined, player, 0)).toBe("mgt_bolt");
    expect(call(engine, "SWMG_GetGunBankGunModel", undefined, player, 0)).toBe("mgt_gun");
    expect(call(engine, "SWMG_GetGunBankDamage", undefined, player, 0)).toBe(7);
    expect(call(engine, "SWMG_GetGunBankTimeBetweenShots", undefined, player, 0)).toBeCloseTo(0.3);
    expect(call(engine, "SWMG_GetGunBankLifespan", undefined, player, 0)).toBe(2.5);
    expect(call(engine, "SWMG_GetGunBankSpeed", undefined, player, 0)).toBe(60);
    expect(call(engine, "SWMG_GetGunBankTarget", undefined, player, 0)).toBe(2);
    expect(call(engine, "SWMG_GetGunBankSensingRadius", undefined, player, 0)).toBe(80);
    expect(call(engine, "SWMG_GetGunBankHorizontalSpread", undefined, player, 0)).toBe(1.5);
    expect(call(engine, "SWMG_GetGunBankDamage", undefined, player, 9)).toBe(0); // missing bank
    call(engine, "SWMG_SetGunBankBulletModel", undefined, player, 0, "mgt_bolt2");
    call(engine, "SWMG_SetGunBankDamage", undefined, player, 0, 11);
    call(engine, "SWMG_SetGunBankTimeBetweenShots", undefined, player, 0, 2);
    call(engine, "SWMG_SetGunBankLifespan", undefined, player, 0, 9);
    call(engine, "SWMG_SetGunBankSpeed", undefined, player, 0, 15);
    call(engine, "SWMG_SetGunBankTarget", undefined, player, 0, 4);
    const bullet = player.gunBanks[0].fire()!;
    expect([bullet.model_name, bullet.damage_amt, bullet.lifespan, bullet.speed, bullet.target_type]).toEqual(["mgt_bolt2", 11, 9, 15, 4]);
    expect(player.gunBanks[0].fireTimer).toBe(2);
    expect(player.gunBanks[0].bulletTemplate).toBeDefined(); // the template survives a model change
    expect(call(engine, "SWMG_IsGunBankTargetting", undefined, enemy, 0)).toBe(0);
    enemy.gunBanks[0].targetting = true;
    expect(call(engine, "SWMG_IsGunBankTargetting", undefined, enemy, 0)).toBe(1);
  });

  test("camera clip planes and per-object sound settings", () => {
    const { mg, enemy } = buildGame(2);
    expect([call(engine, "SWMG_GetCameraNearClip", undefined), call(engine, "SWMG_GetCameraFarClip", undefined)]).toEqual([0.5, 500]);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    (GameState as any).camera = camera; // the engine-side GameState the minigame renders with
    call(engine, "SWMG_SetCameraClip", undefined, 1, 800);
    expect([mg.nearClip, mg.farClip, camera.near, camera.far]).toEqual([1, 800, 1, 800]);
    expect(call(engine, "SWMG_GetSoundVolume", undefined, enemy, 0)).toBe(127);
    call(engine, "SWMG_SetSoundVolume", undefined, enemy, 0, 40);
    call(engine, "SWMG_SetSoundFrequency", undefined, enemy, 1, 22050);
    call(engine, "SWMG_SetSoundFrequencyIsRandom", undefined, enemy, 1, 5);
    expect([
      call(engine, "SWMG_GetSoundVolume", undefined, enemy, 0), call(engine, "SWMG_GetSoundFrequency", undefined, enemy, 1),
      call(engine, "SWMG_GetSoundFrequencyIsRandom", undefined, enemy, 1), call(engine, "SWMG_GetSoundFrequency", undefined, enemy, 0),
    ]).toEqual([40, 22050, 1, 0]);
  });

  test("default handlers: OnBulletHit damages OBJECT_SELF, OnDamage/OnDeath play animations, OnObstacleHit crashes or boosts", () => {
    const { mg, player, enemy, trigger, obstacle } = buildGame(1);
    let hpChange = 0;
    enemy.scripts.OnHitBullet = fakeScript((self) => call(engine, "SWMG_OnBulletHit", self)) as any;
    enemy.scripts.OnDamage = fakeScript((self) => { hpChange = call(engine, "SWMG_GetLastHPChange", self); }) as any;
    const bullet = player.gunBanks[0].fire()!;
    enemy.onHitBullet(bullet);
    expect(enemy.hit_points).toBe(2);
    expect(hpChange).toBe(-7);

    const played: string[] = [];
    (enemy as any).playModelAnimation = (name: string) => played.push(name);
    call(engine, "SWMG_OnDamage", enemy);
    call(engine, "SWMG_OnDeath", enemy);
    expect(played).toEqual(["damage", "die"]);

    player.bump_damage = 2;
    player.speed = 30;
    player.scripts.OnHitObstacle = fakeScript((self) => call(engine, "SWMG_OnObstacleHit", self)) as any;
    player.onHitObstacle(obstacle);
    expect([player.hit_points, player.speed, player.invince]).toEqual([18, 4, 1.5]);
    player.scripts.OnHitFollower = fakeScript((self) => call(engine, "SWMG_OnObstacleHit", self)) as any;
    player.onHitFollower(trigger); // "mgs_accel01": an accelerator pad
    expect(player.speed).toBe(40);
    expect(mg.context.event).toBe("");
  });

  test("event context routines outside any handler report empty values", () => {
    buildGame(1);
    expect([
      call(engine, "SWMG_GetLastEvent", undefined), call(engine, "SWMG_GetLastEventModelName", undefined),
      call(engine, "SWMG_GetLastBulletHitDamage", undefined), call(engine, "SWMG_GetLastBulletHitTarget", undefined),
      call(engine, "SWMG_GetLastBulletHitShooter", undefined), call(engine, "SWMG_GetLastBulletFiredDamage", undefined),
      call(engine, "SWMG_GetLastBulletFiredTarget", undefined), call(engine, "SWMG_GetLastBulletHitPart", undefined),
      call(engine, "SWMG_GetLastFollowerHit", undefined), call(engine, "SWMG_GetLastObstacleHit", undefined),
    ]).toEqual(["", "", 0, 0, undefined, 0, 0, "", undefined, undefined]);
  });
});

describe("TSL-only SWMG routines", () => {
  test("track position, follower position, destroy, jump speed and applied force", () => {
    const { mg, player, enemy, obstacle } = buildGame(1);
    const t = call("tsl", "SWMG_GetTrackPosition", undefined, enemy);
    expect([t.x, t.y, t.z]).toEqual([3, 30, 0]);
    const moved = call("tsl", "SWMG_SetFollowerPosition", enemy, { x: 1, y: 2, z: 0 });
    expect([moved.x, moved.y, moved.z]).toEqual([4, 32, 0]);

    enemy.gunBanks[0].fire();
    expect(enemy.gunBanks[0].bullets).toHaveLength(1);
    call("tsl", "SWMG_DestroyMiniGameObject", undefined, enemy);
    call("tsl", "SWMG_DestroyMiniGameObject", undefined, obstacle);
    expect([mg.enemies.includes(enemy), mg.obstacles.length, enemy.gunBanks[0].bullets.length]).toEqual([false, 0, 0]);

    call("tsl", "SWMG_SetJumpSpeed", undefined, 3);
    expect(player.jumpSpeed).toBe(3);
    player.speed_min = 0; player.speed_max = 0; player.accel_secs = 0; player.speed = 0;
    call("tsl", "SWMG_PlayerApplyForce", undefined, { x: 2, y: 5, z: 0 });
    mg.tick(0.1);
    expect([player.track.position.x, player.track.position.y]).toEqual([2, 10]);
    mg.tick(0.1);
    expect([player.track.position.x, player.track.position.y]).toEqual([2, 10]); // one-shot
  });
});
