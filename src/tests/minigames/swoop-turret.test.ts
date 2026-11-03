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
jest.mock("@/odyssey/controllers/OdysseyController", () => ({ OdysseyController: class {} }));
jest.mock("@/nwscript/NWScript", () => ({ NWScript: class {} }));
jest.mock("@/nwscript/NWScriptInstance", () => ({ NWScriptInstance: class {} }));
jest.mock("@/nwscript/events", () => ({ NWScriptEvent: class {} }));
jest.mock("@/engine/CollisionManager", () => ({ CollisionManager: class {} }));
jest.mock("@/combat", () => ({ CombatRound: class {}, CombatRoundAction: class {} }));

import { GameState } from "@/GameState";
import { ModuleMiniGame } from "@/module/ModuleMiniGame";
import { ModuleMGObstacle } from "@/module/ModuleMGObstacle";
import { ModuleMGPlayer } from "@/module/ModuleMGPlayer";
import { OdysseyModel3D } from "@/three/odyssey";
import { EventTimedEvent } from "@/events/EventTimedEvent";
import { processMiniGameAction } from "@/controls/MiniGameControls";
import { EngineState } from "@/enums/engine/EngineState";
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

function swoopGame(player: Record<string, unknown>, enemies: Record<string, unknown>[] = [], are: Record<string, unknown> = {}) {
  const mg = new ModuleMiniGame(miniGameStruct(SWOOP, { Sphere_Radius: 1, Hit_Points: 10, Max_HPs: 10, ...player }, enemies, are));
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
    const obstacle = await addObstacle(mg, "mgs_rock01", 22);
    obstacle.sphere_radius = 3; // contact while the player is within y 18..26
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
      expect(routine("tsl", GetLastObstacleHit, self)).toBe(obstacle); // the hit pair, seen from the obstacle
    }) as any;
    mg.initMiniGameObjects();

    tickFor(mg, 1.75); // player at y=17.5: 4.5 apart, radii sum 4
    expect(order).toEqual([]);
    mg.tick(0.25);     // y=20: overlapping
    expect(order).toEqual(["player.OnHitObstacle", "obstacle.OnHitFollower"]);
    expect(seen[0]).toBe("OnHitObstacle");
    expect(seen[1]).toBe(obstacle);
    expect(seen[2]).toBe("mgs_rock01");
    tickFor(mg, 0.5);  // y=25: still overlapping, no repeat
    expect(order).toHaveLength(2);
    tickFor(mg, 0.5);  // y=30: separated
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
    pad.sphere_radius = 3; // contact while the player is within y 26..34
    const hits: unknown[] = [];
    mg.player.scripts.OnHitFollower = fakeScript((self) => hits.push(routine("kotor", GetLastFollowerHit, self))) as any;
    mg.initMiniGameObjects();

    tickFor(mg, 2.5); // y=25: 5 apart, radii sum 4
    expect(hits).toEqual([]);
    tickFor(mg, 0.5); // y=30
    expect(hits).toHaveLength(1);
    tickFor(mg, 0.25); // y=32.5: still overlapping, no repeat
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
  test("speed climbs at Accel_Secs to the current gear's cap; a timed shift raises the cap and fires OnAccelerate", () => {
    const mg = swoopGame({ Minimum_Speed: 0, Maximum_Speed: 50, Accel_Secs: 100 });
    const accel = fakeScript((self) => expect(routine("kotor", GetLastEvent, self)).toBe("OnAccelerate"));
    mg.player.scripts.OnAccelerate = accel as any;
    mg.initMiniGameObjects();

    tickFor(mg, 1);
    expect(mg.player.speed).toBe(10); // gear 0 of 5: 0..10
    expect(mg.player.shiftGear()).toBe(true);
    expect(accel.calls).toBe(1);
    expect(mg.player.shiftGear()).toBe(false); // speed 10 is below 90% of gear 1's cap (20)
    tickFor(mg, 1);
    expect(mg.player.speed).toBe(20);
    for (let gear = 2; gear < ModuleMGPlayer.GEAR_COUNT; gear++) {
      expect(mg.player.shiftGear()).toBe(true);
      tickFor(mg, 1);
    }
    expect(mg.player.gear).toBe(ModuleMGPlayer.GEAR_COUNT - 1);
    expect(mg.player.shiftGear()).toBe(false); // top gear
    expect(mg.player.speed).toBe(50);
  });

  test("gear mashing at the start does nothing beyond the first gear's window", () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 60, Accel_Secs: 10 });
    mg.initMiniGameObjects();
    for (let i = 0; i < 10; i++) mg.player.shiftGear();
    expect(mg.player.gear).toBe(0); // speed 0 < 90% of 20
    tickFor(mg, 1);
    expect(mg.player.speed).toBe(20);
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

  test("an explicit track length on an unanimated track: one OnTrackLoop per length, lap times, finish after Num_Loops", () => {
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
    tickFor(mg, 2); // a third lap does not move the finish time
    expect(mg.player.lapTimes).toEqual([2, 2, 2]);
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
      expect(routine("kotor", GetLastHPChange, self)).toBe(-4); // the nested OnDamage's change stays visible
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

/**
 * A track model whose looping animation carries the rider (`length` seconds per loop),
 * driven by the engine's real OdysseyModelAnimationManager, so wraps behave as in game
 * (at most one per update, remainder dropped).
 */
const { OdysseyModelAnimationManager: RealAnimationManager } =
  jest.requireActual("@/odyssey/OdysseyModelAnimationManager") as typeof import("@/odyssey/OdysseyModelAnimationManager");
class FakeAnimatedTrack extends (OdysseyModel3D as unknown as typeof THREE.Object3D) {
  bonesInitialized = true;
  animateFrame = false;
  animLoops: unknown[] = [];
  stopped = 0;
  odysseyAnimations: any[];
  animationManager: any;
  constructor(length: number, y = 0) {
    super();
    const hook = new THREE.Object3D();
    hook.name = "modelhook";
    this.add(hook);
    this.position.y = y;
    this.odysseyAnimations = [{ type: "OdysseyModelAnimation", name: "trackloop", length, nodes: [], events: [], transition: 0 }];
    this.animationManager = new RealAnimationManager(this as any);
  }
  playAnimation() {
    const state = this.animationManager.createAnimationState();
    state.loop = true;
    this.animationManager.setCurrentAnimation(this.odysseyAnimations[0], state);
  }
  stopAnimation() { this.animationManager.currentAnimation = undefined; this.stopped++; }
  update(delta: number) { this.animationManager.update(delta); }
}

const held = { keyboardInput: { down: true, pressed: false } };
const pressedAndHeld = { keyboardInput: { down: true, pressed: true } };
const released = { keyboardInput: { down: false, pressed: false } };

/** A track rotated so the follower's firing axis (+Y) points `degrees` off the player at the origin. */
function aimedTrack(y: number, degrees: number) {
  const track = makeTrack(0, y, 0);
  track.rotation.z = Math.PI + THREE.MathUtils.degToRad(degrees);
  return track;
}

describe("review regressions", () => {
  beforeEach(() => { (GameState as any).State = EngineState.RUNNING; });

  test("an accelerator pad whose own OnHitFollower calls SWMG_OnObstacleHit boosts once and does not crash the player into itself", async () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 50, Accel_Secs: 0, Bump_Damage: 3, Invince_Period: 0 });
    const pad = await addObstacle(mg, "mgs_accel01", 10);
    let boosts = 0;
    mg.player.scripts.OnAccelerate = fakeScript(() => boosts++) as any;
    pad.scripts.OnHitFollower = fakeScript((self) => routine("kotor", OnObstacleHit, self)) as any;
    mg.initMiniGameObjects();
    tickFor(mg, 1);
    expect([mg.player.speed, mg.player.hit_points, boosts]).toEqual([50, 10, 1]);
  });

  test("player and rock scripts both calling SWMG_OnObstacleHit crash the swoop once per contact", async () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 50, Accel_Secs: 0, Bump_Damage: 3, Invince_Period: 0 });
    const rock = await addObstacle(mg, "mgs_rock01", 10);
    mg.player.scripts.OnHitObstacle = fakeScript((self) => routine("kotor", OnObstacleHit, self)) as any;
    rock.scripts.OnHitFollower = fakeScript((self) => routine("kotor", OnObstacleHit, self)) as any;
    mg.initMiniGameObjects();
    tickFor(mg, 1);
    expect(mg.player.hit_points).toBe(7);
  });

  test("a follower's OnHitFollower calling SWMG_OnObstacleHit applies the default with the follower as the thing hit", () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 50, Accel_Secs: 0, Bump_Damage: 2 }, [
      { Track: "trk", Trigger: 1, Sphere_Radius: 1, Models: [{ Model: "mgs_accel", RotatingModel: 0 }] },
    ]);
    mg.enemies[0].setTrack(makeTrack(0, 10, 0));
    mg.player.scripts.OnHitFollower = fakeScript(() => {}) as any; // player script does nothing
    mg.enemies[0].scripts.OnHitFollower = fakeScript((self) => routine("kotor", OnObstacleHit, self)) as any;
    mg.initMiniGameObjects();
    tickFor(mg, 1.5);
    expect([mg.player.speed, mg.player.hit_points]).toEqual([50, 10]);
  });

  test("a second crash inside the invulnerability period is ignored", async () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 10, Accel_Secs: 0, Bump_Damage: 3, Invince_Period: 2 });
    await addObstacle(mg, "mgs_rock01", 10);
    await addObstacle(mg, "mgs_rock02", 15);
    const brakes = fakeScript();
    mg.player.scripts.OnBrake = brakes as any;
    mg.initMiniGameObjects();
    tickFor(mg, 2);
    expect([mg.player.hit_points, brakes.calls]).toEqual([7, 1]);
  });

  test("steering through the minigame key processor uses ARE LateralAccel, stops on release and stays inside TunnelX", () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 10, TunnelXNeg: -5, TunnelXPos: 5 }, [], { LateralAccel: 60 });
    mg.initMiniGameObjects();
    expect(mg.player.accel_lateral_secs).toBe(60);
    processMiniGameAction("left", held, 0.05);
    mg.tick(0.05);
    expect(mg.player.track.position.x).toBeCloseTo(-3);
    processMiniGameAction("left", released, 0.05);
    mg.tick(0.05); // released while moving forward: no drift
    expect(mg.player.track.position.x).toBeCloseTo(-3);
    for (let i = 0; i < 20; i++) { processMiniGameAction("left", held, 0.05); mg.tick(0.05); }
    expect(mg.player.track.position.x).toBeCloseTo(-5);
    for (let i = 0; i < 20; i++) { processMiniGameAction("right", held, 0.05); mg.tick(0.05); }
    expect(mg.player.track.position.x).toBeCloseTo(5);
  });

  test("ARE MovementPerSec caps lateral speed; UseInertia makes it ramp up and coast down at LateralAccel", () => {
    const capped = swoopGame({ Minimum_Speed: 0, Maximum_Speed: 0 }, [], { LateralAccel: 60, MovementPerSec: 8 });
    processMiniGameAction("left", held, 0.5);
    capped.tick(0.5);
    expect(capped.player.track.position.x).toBeCloseTo(-4);

    const inertia = swoopGame({ Minimum_Speed: 0, Maximum_Speed: 0 }, [], { LateralAccel: 10, MovementPerSec: 8, UseInertia: 1 });
    const xs: number[] = [];
    for (const input of [held, held, released, released, released]) {
      processMiniGameAction("left", input, 0.25);
      inertia.tick(0.25);
      xs.push(inertia.player.track.position.x);
    }
    expect(xs.map((x) => Math.round(x * 1000) / 1000)).toEqual([-0.625, -1.875, -2.5, -2.5, -2.5]);

    // Hitting the tunnel wall kills lateral momentum: steering away starts from rest.
    const walled = swoopGame({ Minimum_Speed: 0, Maximum_Speed: 0, TunnelXNeg: -1, TunnelXPos: 1 }, [], { LateralAccel: 10, MovementPerSec: 8, UseInertia: 1 });
    for (let i = 0; i < 8; i++) { processMiniGameAction("left", held, 0.25); walled.tick(0.25); }
    expect(walled.player.track.position.x).toBeCloseTo(-1);
    processMiniGameAction("right", held, 0.25);
    walled.tick(0.25);
    expect(walled.player.track.position.x).toBeCloseTo(-0.375);
  });

  test("gamepad steering and fire use the held state, not the edge/repeat pulse", () => {
    const swoop = swoopGame({ Minimum_Speed: 0, Maximum_Speed: 0 }, [], { LateralAccel: 10 });
    for (let i = 0; i < 4; i++) {
      processMiniGameAction("right", { gamepadInput: { down: true, pressed: i === 0 } } as any, 0.25);
      swoop.tick(0.25);
    }
    expect(swoop.player.track.position.x).toBeCloseTo(10);
    processMiniGameAction("left", { gamepadInput: { value: -0.8, pressThreshold: 0.5, pressed: false } } as any, 0.25);
    swoop.tick(0.25);
    expect(swoop.player.track.position.x).toBeCloseTo(7.5);

    const turret = turretGame({ Gun_Banks: [bulletBank({ Damage: 1, Lifespan: 5, Rate_Of_Fire: 0, Speed: 20 })] }, []);
    processMiniGameAction("shoot", { gamepadInput: { down: true, pressed: false } } as any, 0.1);
    expect(turret.player.gunBanks[0].bullets).toHaveLength(1);
  });

  test("holding the shift key (OS key repeat re-sends pressed) shifts once; release and press shifts again", () => {
    const mg = swoopGame({ Minimum_Speed: 0, Maximum_Speed: 50, Accel_Secs: 100 });
    mg.initMiniGameObjects();
    tickFor(mg, 1);
    processMiniGameAction("shoot", pressedAndHeld, 0.1);
    expect(mg.player.gear).toBe(1);
    tickFor(mg, 1);
    processMiniGameAction("shoot", pressedAndHeld, 0.1); // repeat while still held
    expect(mg.player.gear).toBe(1);
    processMiniGameAction("shoot", released, 0.1);
    processMiniGameAction("shoot", pressedAndHeld, 0.1);
    expect(mg.player.gear).toBe(2);
  });

  test("turret TunnelInfinite frees an axis from its tunnel limits", () => {
    const mg = turretGame({ Tunnellnfinite: { x: 0, y: 0, z: 1 }, TunnelZNeg: 0, TunnelZPos: 0, TunnelXNeg: 0, TunnelXPos: 0 }, []);
    for (let i = 0; i < 3; i++) { mg.player.rotate("z", 0.5); mg.player.rotate("x", 0.5); }
    expect(mg.player.rotation.z).toBeCloseTo(1.5);
    expect(mg.player.rotation.x).toBe(0);
  });

  test("GetLastHPChange: an adjustment outside any handler leaks into no later event; inside a handler it is reported", () => {
    const mg = turretGame({}, [{ Track: "t", Sphere_Radius: 1, Hit_Points: 10, Max_HPs: 10 }]);
    mg.initMiniGameObjects();
    routine("kotor", 590, mg.player, mg.enemies[0], -3, 0); // e.g. from a DelayCommand after its event
    expect(routine("kotor", GetLastHPChange, mg.player)).toBe(0);
    const seen: unknown[] = [];
    mg.player.scripts.OnHeartbeat = fakeScript((self) => {
      seen.push(routine("kotor", GetLastHPChange, self));
      routine("kotor", 590, self, mg.enemies[0], -2, 0);
      seen.push(routine("kotor", GetLastHPChange, self));
    }) as any;
    tickFor(mg, 3);
    expect(seen).toEqual([0, -2]);
    expect(mg.enemies[0].hit_points).toBe(5);
  });

  test("DelayCommand inside OnHitBullet keeps that event's GetLast* values; AssignCommand runs inside the event", () => {
    const mg = turretGame({ Gun_Banks: [bulletBank({ Damage: 4, Lifespan: 5, Rate_Of_Fire: 0, Speed: 20 })] },
      [{ Track: "t", Sphere_Radius: 1, Hit_Points: 10, Max_HPs: 10 }]);
    const module: any = (GameState as any).module;
    module.timeManager = { getFutureTimeFromSeconds: () => ({ pauseDay: 0, pauseTime: 0 }) };
    runtime.gameState.GameEventFactory = { EventTimedEvent };
    mg.initMiniGameObjects();
    const reads: Record<string, unknown> = {};
    const scriptReading = (key: string) => ({
      setCaller() {}, seekTo() {},
      runScript() { reads[key] = routine("kotor", GetLastBulletHitDamage, mg.enemies[0]); },
    });
    const delayed: any[] = [];
    mg.enemies[0].scripts.OnHitBullet = fakeScript((self) => {
      runtime.kotor[7].action.call({ caller: self, delayCommands: delayed }, [0.5, { script: scriptReading("delayed"), offset: 0 }]);
      runtime.kotor[6].action.call({ caller: self }, [self, { script: scriptReading("assigned"), offset: 0 }]);
    }) as any;
    mg.enemies[0].onHitBullet(mg.player.gunBanks[0].fire()!);
    expect(delayed).toHaveLength(1);

    // A later, harder hit overwrites the last values before the delayed action runs.
    mg.enemies[0].scripts.OnHitBullet = undefined as any;
    routine("kotor", 634, mg.player, mg.player, 0, 1); // SWMG_SetGunBankDamage(player, 0, 1)
    mg.enemies[0].onHitBullet(mg.player.gunBanks[0].fire()!);
    expect(routine("kotor", GetLastBulletHitDamage, mg.player)).toBe(1); // last value persists after the event

    delayed[0].execute();
    expect(reads).toEqual({ assigned: 4, delayed: 4 }); // the delayed action reads its own event's values
    expect(routine("kotor", GetLastBulletHitDamage, mg.player)).toBe(1); // live record restored afterwards
  });

  test("an animated track carries the swoop: each animation loop is one OnTrackLoop, at a rate set by speed", () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 10, Num_Loops: 2 });
    const track = new FakeAnimatedTrack(2);
    mg.player.setTrack(track as any);
    const loops = fakeScript((self) => expect(routine("kotor", GetLastEvent, self)).toBe("OnTrackLoop"));
    mg.player.scripts.OnTrackLoop = loops as any;
    mg.initMiniGameObjects();
    tickFor(mg, 1.75);
    expect(loops.calls).toBe(0);
    tickFor(mg, 0.25);
    expect(loops.calls).toBe(1);
    expect(track.position.y).toBe(0); // the animation, not a translation, moves the rider
    tickFor(mg, 2);
    expect([loops.calls, mg.player.finishTime]).toEqual([2, 4]);

    const slow = swoopGame({ Minimum_Speed: 5, Maximum_Speed: 10, Accel_Secs: 0 });
    const slowTrack = new FakeAnimatedTrack(2);
    slow.player.setTrack(slowTrack as any);
    tickFor(slow, 3.75);
    expect(slow.player.loopsCompleted).toBe(0); // half speed: one loop per 4 s
    tickFor(slow, 0.25);
    expect(slow.player.loopsCompleted).toBe(1);
  });

  test("an unanimated track with no explicit length never loops, whatever the room geometry", () => {
    const mg = swoopGame({ Minimum_Speed: 50, Maximum_Speed: 50 });
    const room = new THREE.Mesh(new THREE.BoxGeometry(10, 400, 4));
    room.position.y = 200;
    (GameState as any).module.area.rooms = [{ model: room }];
    expect((mg.player as any).initTrackLength).toBeUndefined();
    mg.initMiniGameObjects();
    tickFor(mg, 20);
    expect([mg.player.trackLength, mg.player.loopsCompleted]).toEqual([0, 0]);
  });

  test("followers loop with their track animation, and a dead follower stops following it", () => {
    const mg = swoopGame({}, [{ Track: "trk", Sphere_Radius: 1, Hit_Points: 10, Max_HPs: 10 }]);
    const enemy = mg.enemies[0];
    const track = new FakeAnimatedTrack(1, 100);
    enemy.setTrack(track);
    const loops = fakeScript();
    enemy.scripts.OnTrackLoop = loops as any;
    mg.initMiniGameObjects();
    tickFor(mg, 2.5);
    expect(loops.calls).toBe(2);
    routine("kotor", 604, mg.player, enemy, 0); // SWMG_SetFollowerHitPoints -> death (default handler)
    expect(track.stopped).toBeGreaterThan(0);
    tickFor(mg, 2);
    expect(loops.calls).toBe(2);
  });

  test("a fast bullet hits a target it passes between frames (swept test)", () => {
    const mg = turretGame({ Gun_Banks: [bulletBank({ Damage: 4, Lifespan: 5, Rate_Of_Fire: 1, Speed: 1000 })] },
      [{ Track: "t", Sphere_Radius: 1, Hit_Points: 10, Max_HPs: 10 }]);
    mg.enemies[0].setTrack(makeTrack(0, 100, 0));
    mg.initMiniGameObjects();
    mg.player.fire();
    mg.tick(0.25); // 0 -> 250 in one frame
    expect(mg.enemies[0].hit_points).toBe(6);
  });

  test("player bullets pass through trigger and dead followers and hit the live one behind them", () => {
    const enemy = (y: number, extra: Record<string, unknown> = {}) => ({ Track: `t${y}`, Sphere_Radius: 1, Hit_Points: 10, Max_HPs: 10, ...extra });
    const mg = turretGame({ Gun_Banks: [bulletBank({ Damage: 4, Lifespan: 5, Rate_Of_Fire: 1, Speed: 20 })] },
      [enemy(5, { Trigger: 1 }), enemy(8), enemy(12)]);
    mg.enemies.forEach((e, i) => e.setTrack(makeTrack(0, [5, 8, 12][i], 0)));
    mg.initMiniGameObjects();
    routine("kotor", 604, mg.player, mg.enemies[1], 0); // dead
    mg.player.fire();
    tickFor(mg, 1);
    expect(mg.enemies.map((e) => e.hit_points)).toEqual([10, 0, 6]);
  });

  test("enemy fire respects Sensing_Radius and trigger followers never fire", () => {
    const shooter = (extra: Record<string, unknown>, sensing: number) => ({
      Track: "t", Sphere_Radius: 1, Hit_Points: 10, Max_HPs: 10, ...extra,
      Gun_Banks: [bulletBank({ Damage: 1, Lifespan: 5, Rate_Of_Fire: 1, Speed: 20 }, { Sensing_Radius: sensing })],
    });
    const mg = turretGame({}, [shooter({}, 5), shooter({}, 50), shooter({ Trigger: 1 }, 50)]);
    mg.enemies.forEach((e) => e.setTrack(aimedTrack(10, 0)));
    mg.initMiniGameObjects();
    mg.tick(0.1);
    expect(mg.enemies.map((e) => e.gunBanks[0].targetting)).toEqual([false, true, false]);
    expect(mg.enemies.map((e) => e.gunBanks[0].bullets.length)).toEqual([0, 1, 0]);
  });

  test("a fighter sweeping past fires when the player is inside its spread cone, and its aimed shots hit", () => {
    const sweep = (spread: number) => {
      const mg = turretGame({}, [{
        Track: "t", Sphere_Radius: 1, Hit_Points: 10, Max_HPs: 10,
        Gun_Banks: [bulletBank({ Damage: 1, Lifespan: 5, Rate_Of_Fire: 0.2, Speed: 20 }, { Horiz_Spread: spread })],
      }]);
      const track = aimedTrack(10, -58.5);
      mg.enemies[0].setTrack(track);
      mg.initMiniGameObjects();
      let fired = 0;
      mg.enemies[0].scripts.OnFire = fakeScript(() => fired++) as any;
      for (let degrees = -58.5; degrees <= 58.5; degrees += 13) { // never closer than 6.5 degrees to the player
        track.rotation.z = Math.PI + THREE.MathUtils.degToRad(degrees);
        mg.tick(0.05);
      }
      tickFor(mg, 1, 0.05);
      return { fired, hp: mg.player.hit_points };
    };
    expect(sweep(0)).toEqual({ fired: 0, hp: 10 }); // the sphere alone subtends 5.7 degrees
    const result = sweep(5);
    expect(result.fired).toBeGreaterThan(0);
    expect(result.hp).toBe(10 - result.fired);
  });
});

describe("review round 2", () => {
  beforeEach(() => { (GameState as any).State = EngineState.RUNNING; });

  const fighter = (y: number, extra: Record<string, unknown> = {}) => ({
    Track: `trk_${y}`, Sphere_Radius: 1, Hit_Points: 10, Max_HPs: 10, Models: [{ Model: "mgt_fighter", RotatingModel: 0 }], ...extra,
  });

  test("GetLastHPChange after SWMG_OnBulletHit and after SWMG_AdjustFollowerHitPoints in the same handler", () => {
    const mg = turretGame({ Gun_Banks: [bulletBank({ Damage: 4, Lifespan: 5, Rate_Of_Fire: 0, Speed: 20 })] }, [fighter(10)]);
    const enemy = mg.enemies[0];
    const seen: unknown[] = [];
    enemy.scripts.OnHitBullet = fakeScript((self) => {
      routine("kotor", OnBulletHit, self);
      seen.push([self.hit_points, routine("kotor", GetLastHPChange, self)]);
      routine("kotor", 590, self, self, -3, 0);
      seen.push([self.hit_points, routine("kotor", GetLastHPChange, self)]);
    }) as any;
    mg.initMiniGameObjects();
    enemy.onHitBullet(mg.player.gunBanks[0].fire()!);
    expect(seen).toEqual([[6, -4], [3, -3]]);
  });

  test("OnDamage raised by a bullet sees the damage, shooter and part", () => {
    const mg = turretGame({ Gun_Banks: [bulletBank({ Damage: 4, Lifespan: 5, Rate_Of_Fire: 0, Speed: 20 })] }, [fighter(10)]);
    const enemy = mg.enemies[0];
    let seen: unknown[] = [];
    enemy.scripts.OnDamage = fakeScript((self) => {
      seen = [routine("kotor", GetLastEvent, self), routine("kotor", GetLastHPChange, self), routine("kotor", GetLastBulletHitDamage, self),
        routine("kotor", GetLastBulletHitShooter, self), routine("kotor", GetLastBulletHitPart, self)];
    }) as any;
    mg.initMiniGameObjects();
    enemy.onHitBullet(mg.player.gunBanks[0].fire()!);
    expect(seen.length).toBe(5);
    expect(seen.slice(0, 3)).toEqual(["OnDamage", -4, 4]);
    expect(seen[3]).toBe(mg.player);
    expect(seen[4]).toBe("mgt_fighter");
  });

  test("OnDeath from a lethal bullet sees the HP change, the damage and the killer", () => {
    const mg = turretGame({ Gun_Banks: [bulletBank({ Damage: 20, Lifespan: 5, Rate_Of_Fire: 0, Speed: 20 })] }, [fighter(10)]);
    const enemy = mg.enemies[0];
    let seen: unknown[] = [];
    enemy.scripts.OnDeath = fakeScript((self) => {
      seen = [routine("kotor", GetLastEvent, self), routine("kotor", GetLastHPChange, self),
        routine("kotor", GetLastBulletHitDamage, self), routine("kotor", GetLastBulletHitShooter, self)];
    }) as any;
    mg.initMiniGameObjects();
    enemy.onHitBullet(mg.player.gunBanks[0].fire()!);
    expect(enemy.alive).toBe(false);
    expect(seen.slice(0, 3)).toEqual(["OnDeath", -20, 20]);
    expect(seen[3]).toBe(mg.player);
  });

  test("the swoop's OnDamage after a crash sees the rock it hit", async () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 10, Bump_Damage: 3 });
    const rock = await addObstacle(mg, "mgs_rock01", 2);
    let seen: unknown[] = [];
    mg.player.scripts.OnDamage = fakeScript((self) => {
      seen = [routine("kotor", GetLastHPChange, self), routine("kotor", GetLastObstacleHit, self)];
    }) as any;
    mg.initMiniGameObjects();
    tickFor(mg, 1, 0.05);
    expect(seen[0]).toBe(-3);
    expect(seen[1]).toBe(rock);
  });

  test("SWMG_SetPlayerTunnelNeg/Pos change where swoop steering stops", () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 10, TunnelXNeg: -5, TunnelXPos: 5 }, [], { LateralAccel: 60 });
    mg.initMiniGameObjects();
    routine("kotor", 654, mg.player, { x: -1, y: 0, z: 0 });
    routine("kotor", 652, mg.player, { x: 8, y: 0, z: 0 });
    for (let i = 0; i < 20; i++) { processMiniGameAction("left", held, 0.05); mg.tick(0.05); }
    expect(mg.player.track.position.x).toBeCloseTo(-1);
    for (let i = 0; i < 20; i++) { processMiniGameAction("right", held, 0.05); mg.tick(0.05); }
    expect(mg.player.track.position.x).toBeCloseTo(8);
  });

  test("the lane centre follows the track start and SWMG_SetPlayerOrigin", () => {
    const mg = swoopGame({ Minimum_Speed: 0, Maximum_Speed: 0, TunnelXNeg: -5, TunnelXPos: 5 }, [], { LateralAccel: 60 });
    mg.player.setTrack(makeTrack(10, 0, 0) as any);
    for (let i = 0; i < 20; i++) { processMiniGameAction("left", held, 0.05); mg.tick(0.05); }
    expect(mg.player.track.position.x).toBeCloseTo(5);
    routine("kotor", 656, mg.player, { x: -20, y: 0, z: 0 }); // SWMG_SetPlayerOrigin
    for (let i = 0; i < 20; i++) { processMiniGameAction("right", held, 0.05); mg.tick(0.05); }
    expect(mg.player.track.position.x).toBeCloseTo(-15);
  });

  test("with UseInertia the swoop also coasts down from a rightward slide", () => {
    const mg = swoopGame({ Minimum_Speed: 0, Maximum_Speed: 0 }, [], { LateralAccel: 10, MovementPerSec: 8, UseInertia: 1 });
    const xs: number[] = [];
    for (const input of [held, held, released, released, released]) {
      processMiniGameAction("right", input, 0.25);
      mg.tick(0.25);
      xs.push(Math.round(mg.player.track.position.x * 1000) / 1000);
    }
    expect(xs).toEqual([0.625, 1.875, 2.5, 2.5, 2.5]);
  });

  test("minigame input is ignored while paused, and fire held through a pause or menu needs a fresh press", () => {
    const swoop = swoopGame({ Minimum_Speed: 0, Maximum_Speed: 0 }, [], { LateralAccel: 10 });
    (GameState as any).State = EngineState.PAUSED;
    processMiniGameAction("left", held, 0.25);
    swoop.tick(0.25);
    expect(swoop.player.track.position.x).toBe(0);

    const mg = turretGame({ Gun_Banks: [bulletBank({ Damage: 1, Lifespan: 5, Rate_Of_Fire: 0, Speed: 20 })] }, []);
    const bullets = () => mg.player.gunBanks[0].bullets.length;
    (GameState as any).State = EngineState.PAUSED;
    processMiniGameAction("shoot", held, 0.1);  // fire held while paused
    (GameState as any).State = EngineState.RUNNING;
    processMiniGameAction("shoot", held, 0.1);  // still held after unpausing
    expect(bullets()).toBe(0);
    processMiniGameAction("shoot", released, 0.1);
    processMiniGameAction("shoot", held, 0.1);
    expect(bullets()).toBe(1);

    mg.resumeInput(); // a menu closed back into the minigame (GameState.RestoreEnginePlayMode)
    processMiniGameAction("shoot", held, 0.1);
    expect(bullets()).toBe(1);
    processMiniGameAction("shoot", released, 0.1);
    processMiniGameAction("shoot", held, 0.1);
    expect(bullets()).toBe(2);
  });

  test("the player never crashes into itself, and the default needs a hit target", () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 50, Accel_Secs: 0, Bump_Damage: 3 });
    mg.player.speed = 30;
    mg.player.defaultObstacleHit(mg.player);
    mg.player.scripts.OnHeartbeat = fakeScript((self) => routine("kotor", OnObstacleHit, self)) as any;
    mg.initMiniGameObjects();
    tickFor(mg, 3);
    expect([mg.player.hit_points, mg.player.speed]).toEqual([10, 30]);
  });

  test("player and follower scripts both calling SWMG_OnObstacleHit crash the swoop once per contact", () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 50, Accel_Secs: 0, Bump_Damage: 3, Invince_Period: 0 }, [
      { Track: "trk", Sphere_Radius: 1, Hit_Points: 10, Max_HPs: 10, Models: [{ Model: "mgs_wall", RotatingModel: 0 }] },
    ]);
    mg.enemies[0].setTrack(makeTrack(0, 10, 0));
    mg.player.scripts.OnHitFollower = fakeScript((self) => routine("kotor", OnObstacleHit, self)) as any;
    mg.enemies[0].scripts.OnHitFollower = fakeScript((self) => routine("kotor", OnObstacleHit, self)) as any;
    mg.initMiniGameObjects();
    tickFor(mg, 1);
    expect(mg.player.hit_points).toBe(7);
  });

  test("an obstacle's OnHitFollower reports the player's model as the event model", async () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 10, Models: [{ Model: "mgs_swoop", RotatingModel: 0 }] });
    const rock = await addObstacle(mg, "mgs_rock01", 10);
    let model = "";
    rock.scripts.OnHitFollower = fakeScript((self) => { model = routine("kotor", GetLastEventModelName, self); }) as any;
    mg.initMiniGameObjects();
    tickFor(mg, 1);
    expect(model).toBe("mgs_swoop");
  });

  test("enemy shots deviate by up to Inaccuracy", () => {
    const mg = turretGame({}, [fighter(10, { Gun_Banks: [bulletBank({ Damage: 1, Lifespan: 5, Rate_Of_Fire: 1, Speed: 20 }, { Inaccuracy: 30 })] })]);
    mg.enemies[0].setTrack(aimedTrack(10, 0));
    jest.spyOn(Math, "random").mockReturnValue(1); // the largest deviation
    mg.initMiniGameObjects();
    mg.tick(0.1);
    const bullet = mg.enemies[0].gunBanks[0].bullets[0];
    expect(THREE.MathUtils.radToDeg(bullet.direction.angleTo(new THREE.Vector3(0, -1, 0)))).toBeCloseTo(30);
  });

  test("a bank targets a player whose sphere contains the muzzle, and never fires backwards", () => {
    const shooter = { Gun_Banks: [bulletBank({ Damage: 1, Lifespan: 5, Rate_Of_Fire: 1, Speed: 20 }, { Horiz_Spread: 179 })] };
    const mg = turretGame({}, [fighter(0.5, shooter), fighter(10, shooter)]);
    mg.enemies[0].setTrack(makeTrack(0, 0.5, 0)); // inside the player's sphere, facing away
    mg.enemies[1].setTrack(makeTrack(0, 10, 0));  // player directly behind, very wide spread
    mg.initMiniGameObjects();
    mg.tick(0.1);
    expect(mg.enemies.map((e) => e.gunBanks[0].targetting)).toEqual([true, false]);
  });

  test("laps are counted from accumulated track time: a loop shorter than a frame still credits every lap", () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 10 });
    const track = new FakeAnimatedTrack(0.2);
    mg.player.setTrack(track as any);
    mg.initMiniGameObjects();
    tickFor(mg, 1);
    expect(mg.player.loopsCompleted).toBe(5);
    // the real animation manager wrapped at most once per update
    expect(track.animationManager.currentAnimationState.elapsedCount).toBeLessThan(5);
  });

  test("a huge frame is sub-stepped and capped", () => {
    const mg = swoopGame({ Minimum_Speed: 10, Maximum_Speed: 10 });
    mg.player.setTrack(new FakeAnimatedTrack(0.5) as any);
    mg.initMiniGameObjects();
    mg.tick(5); // e.g. a backgrounded tab
    expect(mg.elapsed).toBe(ModuleMiniGame.MAX_FRAME);
    expect(mg.player.loopsCompleted).toBe(2);
  });

  test("without Maximum_Speed an animated track stands still at speed 0 and runs at full rate once moving", () => {
    const mg = swoopGame({ Minimum_Speed: 0, Maximum_Speed: 0, Accel_Secs: 0 });
    mg.player.setTrack(new FakeAnimatedTrack(1) as any);
    mg.initMiniGameObjects();
    tickFor(mg, 3);
    expect(mg.player.loopsCompleted).toBe(0);
    mg.player.speed = 3;
    tickFor(mg, 2);
    expect(mg.player.loopsCompleted).toBe(2);
  });
});

describe("review round 2: stepping", () => {
  test("a long frame is simulated in steps, so a fast swoop cannot skip an obstacle", async () => {
    const mg = swoopGame({ Minimum_Speed: 100, Maximum_Speed: 100 });
    await addObstacle(mg, "mgs_rock01", 50);
    const hits = fakeScript();
    mg.player.scripts.OnHitObstacle = hits as any;
    mg.initMiniGameObjects();
    mg.tick(1); // 100 units in one frame; steps of 0.25 land on y=50
    expect(hits.calls).toBe(1);
  });

  test("followers credit every loop of a track shorter than a frame", () => {
    const mg = swoopGame({}, [{ Track: "trk", Sphere_Radius: 1, Hit_Points: 10, Max_HPs: 10 }]);
    mg.enemies[0].setTrack(new FakeAnimatedTrack(0.2, 100));
    mg.initMiniGameObjects();
    tickFor(mg, 1);
    expect(mg.enemies[0].loopsCompleted).toBe(5);
  });
});
