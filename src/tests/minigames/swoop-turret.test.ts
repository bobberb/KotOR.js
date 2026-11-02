import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import * as THREE from "three";

// Headless boundaries: no renderer, no model/script loading, no disk. The minigame
// classes, ModuleObject, GFF, THREE math and the NWScript routine tables stay real.
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
import { ModuleMGPlayer } from "@/module/ModuleMGPlayer";
import { harness } from "../nwscript/routineHarness";
import { bulletBank, fakeScript, makeTrack, miniGameStruct } from "./minigameFixture";

const SWOOP = 1;
const TURRET = 2;

// Routine IDs (identical in K1 and TSL).
const GetLastEvent = 583, GetLastEventModelName = 584, GetLastBulletHitDamage = 587, GetLastBulletHitTarget = 588,
  GetLastBulletHitShooter = 589, OnBulletHit = 591, OnObstacleHit = 592, GetLastFollowerHit = 593,
  GetLastObstacleHit = 594, GetLastBulletFiredDamage = 595, GetLastBulletFiredTarget = 596, GetLastHPChange = 606,
  GetLastBulletHitPart = 639, SetJumpSpeedTSL = 804;

let runtime: ReturnType<typeof harness>;
beforeAll(() => { runtime = harness(); });

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

/** Call a routine through the reconciled action map, as the VM would. */
function routine(engine: "kotor" | "tsl", id: number, caller: unknown, ...args: unknown[]) {
  return runtime[engine][id].action.call({ caller }, args);
}

function swoopGame(player: Record<string, unknown>, enemies: Record<string, unknown>[] = []) {
  const mg = new ModuleMiniGame(miniGameStruct(SWOOP, { Sphere_Radius: 1, Hit_Points: 10, Max_HPs: 10, ...player }, enemies));
  mg.player.initProperties();
  mg.player.setTrack(makeTrack() as any);
  for (const enemy of mg.enemies) enemy.initProperties();
  installMiniGame(mg);
  return mg;
}

async function addObstacle(mg: ModuleMiniGame, name: string, y: number) {
  const obstacle = new ModuleMGObstacle(undefined, { name, position: new THREE.Vector3(0, y, 0) });
  mg.obstacles.push(obstacle);
  await mg.loadMGObstacles();
  return obstacle;
}

function turretGame(player: Record<string, unknown>, enemies: Record<string, unknown>[]) {
  const mg = new ModuleMiniGame(miniGameStruct(TURRET, { Sphere_Radius: 1, Hit_Points: 10, Max_HPs: 10, ...player }, enemies));
  mg.player.initProperties();
  for (const bank of mg.player.gunBanks) bank.initProperties();
  for (const enemy of mg.enemies) {
    enemy.initProperties();
    for (const bank of enemy.gunBanks) bank.initProperties();
  }
  installMiniGame(mg);
  return mg;
}

function tickFor(mg: ModuleMiniGame, seconds: number, step = 0.25) {
  for (let t = 0; t < seconds - 1e-9; t += step) mg.tick(step);
}

describe("swoop race: collisions and event dispatch", () => {
  test("hitting an obstacle runs player OnHitObstacle then obstacle OnHitFollower, once per contact, with the hit context", async () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 10 });
    const obstacle = await addObstacle(mg, "mgs_rock01", 20);
    const order: string[] = [];
    let seen: unknown[] = [];
    mg.player.scripts.OnHitObstacle = fakeScript((self) => {
      order.push("player.OnHitObstacle");
      seen = [routine("kotor", GetLastEvent, self), routine("kotor", GetLastObstacleHit, self), routine("kotor", GetLastEventModelName, self)];
    }) as any;
    obstacle.scripts.OnHitFollower = fakeScript((self) => {
      order.push("obstacle.OnHitFollower");
      expect(routine("tsl", GetLastEvent, self)).toBe("OnHitFollower");
      expect(routine("tsl", GetLastFollowerHit, self)).toBe(mg.player);
    }) as any;
    mg.initMiniGameObjects();

    tickFor(mg, 1.75); // player at y=17.5: spheres (r=1 each) 2.5 apart
    expect(order).toEqual([]);
    mg.tick(0.25);     // y=20: overlapping
    expect(order).toEqual(["player.OnHitObstacle", "obstacle.OnHitFollower"]);
    expect(seen[0]).toBe("OnHitObstacle");
    expect(seen[1]).toBe(obstacle);
    expect(seen[2]).toBe("mgs_rock01");
    tickFor(mg, 0.25); // still overlapping: no repeat
    expect(order).toHaveLength(2);
    expect(routine("kotor", GetLastEvent, mg.player)).toBe(""); // context ends with the handler
  });

  test("default obstacle hit (no script) crashes the swoop: bump damage, min speed, first gear, invulnerability, OnBrake", async () => {
    const mg = swoopGame({ Minimum_Speed: 5, Maximum_Speed: 25, Accel_Secs: 0, Bump_Damage: 3, Invince_Period: 2 });
    await addObstacle(mg, "mgs_rock01", 12);
    const brakes = fakeScript();
    mg.player.scripts.OnBrake = brakes as any;
    mg.player.gear = 4;
    mg.player.speed = 25;
    mg.initMiniGameObjects();

    mg.tick(0.5); // y=12.5: hit
    expect(mg.player.hit_points).toBe(7);
    expect(mg.player.speed).toBe(5);
    expect(mg.player.gear).toBe(0);
    expect(mg.player.invince).toBe(2);
    expect(brakes.calls).toBe(1);
  });

  test("accelerator pad: OnHitObstacle calling SWMG_OnObstacleHit boosts to top speed and nests OnAccelerate", async () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 50, Accel_Secs: 0 });
    const pad = await addObstacle(mg, "mgs_accel01", 10);
    const order: string[] = [];
    mg.player.scripts.OnHitObstacle = fakeScript((self) => {
      order.push(`hit:${routine("kotor", GetLastEvent, self)}`);
      routine("kotor", OnObstacleHit, self);
      // After the nested OnAccelerate returns, this handler's context is intact.
      order.push(`after:${routine("kotor", GetLastEvent, self)}:${routine("kotor", GetLastObstacleHit, self) === pad}`);
    }) as any;
    mg.player.scripts.OnAccelerate = fakeScript((self) => {
      order.push(`accel:${routine("kotor", GetLastEvent, self)}`);
    }) as any;
    mg.initMiniGameObjects();

    tickFor(mg, 1);
    expect(order).toEqual(["hit:OnHitObstacle", "accel:OnAccelerate", "after:OnHitObstacle:true"]);
    expect(mg.player.speed).toBe(50);
  });

  test("trigger followers on their own tracks raise OnHitFollower in world space", async () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 10 }, [
      { Track: "trk_pad", Trigger: 1, Sphere_Radius: 1, Models: [{ Model: "mgs_accel", RotatingModel: 0 }] },
    ]);
    const pad = mg.enemies[0];
    pad.setTrack(makeTrack(0, 30, 0));
    const hits: unknown[] = [];
    mg.player.scripts.OnHitFollower = fakeScript((self) => hits.push(routine("kotor", GetLastFollowerHit, self))) as any;
    mg.initMiniGameObjects();

    tickFor(mg, 2.5); // y=25: 5 apart
    expect(hits).toEqual([]);
    tickFor(mg, 0.5); // y=30
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(pad);
    expect(pad.name).toBe("mgs_accel");
  });

  test("airborne swoops clear obstacles (TSL SWMG_SetJumpSpeed enables jumping)", async () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 10 });
    await addObstacle(mg, "mgs_rock01", 5);
    const hits = fakeScript();
    mg.player.scripts.OnHitObstacle = hits as any;
    mg.initMiniGameObjects();

    expect(mg.player.jump()).toBe(false); // no jump speed: K1 swoop does not jump
    routine("tsl", SetJumpSpeedTSL, mg.player, 6);
    expect(mg.player.jump()).toBe(true);
    tickFor(mg, 0.75, 0.05); // y=7.5, still in the air (6 m/s up, 9.8 m/s^2 down)
    expect(mg.player.isAirborne()).toBe(true);
    expect(hits.calls).toBe(0);
  });
});

describe("swoop race: speed, gears, boost, steering", () => {
  test("speed climbs at Accel_Secs to the current gear's cap; shifting raises the cap and fires OnAccelerate", () => {
    const mg = swoopGame({ Minimum_Speed: 0, Maximum_Speed: 50, Accel_Secs: 100 });
    const accel = fakeScript((self) => expect(routine("kotor", GetLastEvent, self)).toBe("OnAccelerate"));
    mg.player.scripts.OnAccelerate = accel as any;
    mg.initMiniGameObjects();

    tickFor(mg, 1);
    expect(mg.player.speed).toBe(10); // gear 0 of 5: 0..10
    expect(mg.player.shiftGear()).toBe(true);
    expect(accel.calls).toBe(1);
    tickFor(mg, 1);
    expect(mg.player.speed).toBe(20);
    for (let i = 0; i < 10; i++) mg.player.shiftGear();
    expect(mg.player.gear).toBe(ModuleMGPlayer.GEAR_COUNT - 1);
    tickFor(mg, 1);
    expect(mg.player.speed).toBe(50);
  });

  test("a boost above the gear cap bleeds back down at Accel_Secs; distance follows speed", () => {
    const mg = swoopGame({ Minimum_Speed: 0, Maximum_Speed: 50, Accel_Secs: 100 });
    mg.initMiniGameObjects();
    tickFor(mg, 1);
    mg.player.boost();
    expect(mg.player.speed).toBe(50);
    const y0 = mg.player.track.position.y;
    mg.tick(0.25);
    expect(mg.player.speed).toBe(25);
    expect(mg.player.track.position.y - y0).toBeCloseTo(6.25);
    mg.tick(0.25);
    expect(mg.player.speed).toBe(10);
  });

  test("steering input is consumed once per frame instead of sticking", () => {
    const mg = swoopGame({ Minimum_Speed: 0, Maximum_Speed: 0 });
    mg.initMiniGameObjects();
    mg.player.lateralForce = 4;
    mg.tick(0.5);
    expect(mg.player.track.position.x).toBe(2);
    mg.tick(0.5);
    expect(mg.player.track.position.x).toBe(2);
  });

  test("the track length defaults to the distance from the start to the far end of the room geometry", () => {
    const mg = swoopGame({});
    mg.player.setTrack(makeTrack(0, 5, 0) as any);
    const room = new THREE.Mesh(new THREE.BoxGeometry(10, 40, 4));
    room.position.y = 20; // spans y 0..40
    mg.player.initTrackLength([{ model: room }, {}]);
    expect(mg.player.trackLength).toBe(35);
    mg.player.trackLength = 12;
    mg.player.initTrackLength([{ model: room }]);
    expect(mg.player.trackLength).toBe(12); // an explicit length wins
  });

  test("each track length travelled is one OnTrackLoop with lap times; the race finishes after Num_Loops", () => {
    const mg = swoopGame({ Minimum_Speed: 5, Maximum_Speed: 5, Num_Loops: 2 });
    mg.player.trackLength = 10;
    const loops: string[] = [];
    mg.player.scripts.OnTrackLoop = fakeScript((self) => loops.push(routine("kotor", GetLastEvent, self))) as any;
    mg.initMiniGameObjects();

    tickFor(mg, 1.75);
    expect(loops).toEqual([]);
    tickFor(mg, 0.25);
    expect(loops).toEqual(["OnTrackLoop"]);
    expect(mg.player.track.position.y).toBe(0); // back at the start of the track
    expect(mg.player.finishTime).toBe(-1);
    tickFor(mg, 2);
    expect(loops).toEqual(["OnTrackLoop", "OnTrackLoop"]);
    expect(mg.player.lapTimes).toEqual([2, 2]);
    expect(mg.player.finishTime).toBe(4);
  });
});

describe("minigame lifecycle", () => {
  test("OnCreate runs once per object even though the area also calls runMiniGameScripts", async () => {
    const mg = swoopGame({}, [{ Track: "trk_a", Models: [] }]);
    const obstacle = await addObstacle(mg, "mgs_rock01", 50);
    const creates = [fakeScript(), fakeScript(), fakeScript()];
    mg.enemies[0].scripts.OnCreate = creates[0] as any;
    obstacle.scripts.OnCreate = creates[1] as any;
    mg.player.scripts.OnCreate = creates[2] as any;

    mg.initMiniGameObjects();   // ModuleArea: after spawning
    mg.runMiniGameScripts();    // ModuleArea.runStartScripts
    expect(creates.map((s) => s.calls)).toEqual([1, 1, 1]);
  });

  test("OnHeartbeat fires every 3 seconds for the player, followers and obstacles, only after OnCreate", async () => {
    const mg = swoopGame({}, [{ Track: "trk_a", Models: [] }]);
    const obstacle = await addObstacle(mg, "mgs_rock01", 50);
    const beats = [fakeScript(), fakeScript(), fakeScript()];
    let event = "";
    beats[0] = fakeScript((self) => { event = routine("kotor", GetLastEvent, self); });
    mg.player.scripts.OnHeartbeat = beats[0] as any;
    mg.enemies[0].scripts.OnHeartbeat = beats[1] as any;
    obstacle.scripts.OnHeartbeat = beats[2] as any;

    tickFor(mg, 3);
    expect(beats.map((s) => s.calls)).toEqual([0, 0, 0]); // not created yet
    mg.initMiniGameObjects();
    tickFor(mg, 2.75);
    expect(beats.map((s) => s.calls)).toEqual([0, 0, 0]);
    tickFor(mg, 0.25);
    expect(beats.map((s) => s.calls)).toEqual([1, 1, 1]);
    tickFor(mg, 3);
    expect(beats.map((s) => s.calls)).toEqual([2, 2, 2]);
    expect(event).toBe("OnHeartbeat");
  });

  test("model animation events raise OnAnimEvent with the event and model name", () => {
    const mg = swoopGame({});
    let seen: unknown[] = [];
    mg.player.scripts.OnAnimEvent = fakeScript((self) => {
      seen = [routine("kotor", GetLastEvent, self), routine("kotor", GetLastEventModelName, self)];
    }) as any;
    const model = new THREE.Object3D();
    model.name = "mgs_swoopbike";
    mg.player.listenForAnimEvents(model);
    (model as any).dispatchEvent({ type: "playEvent", event: "snd_boost" });
    expect(seen).toEqual(["snd_boost", "mgs_swoopbike"]);
  });
});

describe("turret: gun banks, bullets, damage and death", () => {
  const enemyAt = (y: number, extra: Record<string, unknown> = {}) => ({
    Track: "trk_fighter", Sphere_Radius: 1, Hit_Points: 10, Max_HPs: 10, Models: [{ Model: "mgt_fighter", RotatingModel: 0 }], ...extra,
  });

  test("player bullets travel at Speed, hit an enemy sphere and report the hit inside OnHitBullet", () => {
    const mg = turretGame({ Gun_Banks: [bulletBank({ Damage: 4, Lifespan: 5, Rate_Of_Fire: 0.5, Speed: 20, Target_Type: 3 })] }, [enemyAt(10)]);
    const enemy = mg.enemies[0];
    enemy.setTrack(makeTrack(0, 10, 0));
    let seen: unknown[] = [];
    enemy.scripts.OnHitBullet = fakeScript((self) => {
      seen = [
        routine("kotor", GetLastEvent, self), routine("kotor", GetLastBulletHitDamage, self),
        routine("kotor", GetLastBulletHitTarget, self), routine("kotor", GetLastBulletHitShooter, self),
        routine("kotor", GetLastBulletHitPart, self),
      ];
      routine("kotor", OnBulletHit, self); // the default: take the bullet's damage
      expect(routine("kotor", GetLastHPChange, self)).toBe(0); // still this handler's context
    }) as any;
    let fired: unknown[] = [];
    mg.player.scripts.OnFire = fakeScript((self) => {
      fired = [routine("kotor", GetLastEvent, self), routine("kotor", GetLastBulletFiredDamage, self), routine("kotor", GetLastBulletFiredTarget, self)];
    }) as any;
    mg.initMiniGameObjects();

    mg.player.fire();
    expect(fired).toEqual(["OnFire", 4, 3]);
    expect(mg.player.gunBanks[0].bullets).toHaveLength(1);
    tickFor(mg, 0.25);
    expect(enemy.hit_points).toBe(10); // y=5
    tickFor(mg, 0.25);
    expect(seen).toEqual(["OnHitBullet", 4, 3, mg.player, "mgt_fighter"]);
    expect(enemy.hit_points).toBe(6);
    expect(mg.player.gunBanks[0].bullets).toHaveLength(0);
  });

  test("rate of fire gates shots; the third hit kills the enemy and OnDeath runs exactly once", () => {
    const mg = turretGame({ Gun_Banks: [bulletBank({ Damage: 4, Lifespan: 5, Rate_Of_Fire: 0.5, Speed: 40 })] }, [enemyAt(10)]);
    const enemy = mg.enemies[0];
    enemy.setTrack(makeTrack(0, 10, 0));
    const damage: number[] = [];
    enemy.scripts.OnDamage = fakeScript((self) => damage.push(routine("kotor", GetLastHPChange, self))) as any;
    const deaths = fakeScript((self) => expect(routine("tsl", GetLastEvent, self)).toBe("OnDeath"));
    enemy.scripts.OnDeath = deaths as any;
    mg.initMiniGameObjects();

    expect(mg.player.gunBanks[0].fire()).toBeDefined();
    expect(mg.player.gunBanks[0].fire()).toBeUndefined(); // still cooling down
    for (let i = 0; i < 12; i++) {
      mg.player.fire();
      mg.tick(0.25);
    }
    expect(damage).toEqual([-4, -4, -4]);
    expect(enemy.alive).toBe(false);
    expect(deaths.calls).toBe(1);
    expect(enemy.hit_points).toBe(-2);
  });

  test("enemy gun banks fire at the player in their line of fire; the player dies and OnDeath runs (lose condition)", () => {
    const mg = turretGame({ Hit_Points: 5, Max_HPs: 5 }, [
      enemyAt(10, { Gun_Banks: [bulletBank({ Damage: 3, Lifespan: 5, Rate_Of_Fire: 1, Speed: 20 })] }),
    ]);
    const enemy = mg.enemies[0];
    const track = makeTrack(0, 10, 0);
    track.rotation.z = Math.PI; // the enemy's +Y (its firing axis) now points at the player
    enemy.setTrack(track);
    const playerDeath = fakeScript();
    mg.player.scripts.OnDeath = playerDeath as any;
    mg.initMiniGameObjects();

    tickFor(mg, 0.25);
    expect(enemy.gunBanks[0].targetting).toBe(true);
    tickFor(mg, 2.5);
    expect(mg.player.hit_points).toBe(-1);
    expect(mg.player.alive).toBe(false);
    expect(playerDeath.calls).toBe(1);
  });

  test("an enemy looking away does not fire; invulnerable targets take no bullet damage", () => {
    const mg = turretGame({ Invince_Period: 10 }, [
      enemyAt(10, { Gun_Banks: [bulletBank({ Damage: 3, Lifespan: 5, Rate_Of_Fire: 1, Speed: 20 })] }),
    ]);
    const enemy = mg.enemies[0];
    enemy.setTrack(makeTrack(0, 10, 0)); // facing +Y, away from the player at the origin
    mg.initMiniGameObjects();
    tickFor(mg, 1);
    expect(enemy.gunBanks[0].targetting).toBe(false);
    expect(enemy.gunBanks[0].bullets).toHaveLength(0);

    mg.player.startInvulnerability();
    mg.player.damage(5);
    expect(mg.player.hit_points).toBe(10);
  });
});
