import * as THREE from "three";
import { GameState } from "@/GameState";
import { MiniGameType } from "@/enums/engine/MiniGameType";
import { ModuleObjectScript } from "@/enums/module/ModuleObjectScript";
import { GFFObject } from "@/resource/GFFObject";
import { GFFStruct } from "@/resource/GFFStruct";
import { ModuleMGEnemy } from "@/module/ModuleMGEnemy";
import type { ModuleMGObstacle } from "@/module/ModuleMGObstacle";
import { ModuleMGPlayer } from "@/module/ModuleMGPlayer";
import type { ModuleMGTrack } from "@/module/ModuleMGTrack";
import type { ModuleMGGunBullet } from "@/module/ModuleMGGunBullet";
import type { ModuleObject } from "@/module/ModuleObject";

/** Minigame objects that can take damage, die and run the shared default handlers. */
export interface IMiniGameCombatant extends ModuleObject {
  hit_points: number;
  max_hps: number;
  invince: number;
  alive: boolean;
  defaultOnDamage(): void;
  defaultOnDeath(): void;
}

/**
 * The minigame's "last values" record, read by the SWMG_GetLast* routines. Like the
 * engine-global retail state, a value stays until an event overwrites it, so a nested
 * event (OnDamage raised inside OnHitBullet) still sees the bullet, and what it writes
 * stays visible to the outer handler. Only `event`/`modelName` are restored on return.
 */
export interface IMiniGameEventContext {
  event: string;
  modelName: string;
  /** What the player ran into in the current/last player hit event (resolves SWMG_OnObstacleHit). */
  hitTarget?: ModuleObject;
  followerHit?: ModuleObject;
  obstacleHit?: ModuleObject;
  bullet?: ModuleMGGunBullet;
  bulletHitDamage: number;
  bulletHitTarget: number;
  bulletHitShooter?: ModuleObject;
  bulletHitPart: string;
  bulletFiredDamage: number;
  bulletFiredTarget: number;
  hpChange: number;
}

/**
* ModuleMiniGame class.
*
* Class representing the minigame instance in a minigame module.
*
* KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
*
* @file ModuleMiniGame.ts
* @author KobaltBlu <https://github.com/KobaltBlu>
* @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
* @memberof KotOR
*/
export class ModuleMiniGame {
  /** Seconds between OnHeartbeat events, matching the engine's 3s object heartbeat. */
  static readonly HEARTBEAT_INTERVAL = 3;
  /** Longest simulation step (seconds); longer frames are sub-stepped. */
  static readonly MAX_STEP = 0.25;
  /** Longest frame simulated (seconds); anything beyond is dropped like a pause. */
  static readonly MAX_FRAME = 1;

  type: MiniGameType;

  /**
   * Mid-minigame save/load is unsupported: SaveGame.CanSaveCurrentGame() refuses to
   * save while an area has a minigame, so no save ever contains minigame runtime state.
   */
  readonly supportsRuntimeStatePersistence: boolean = false;

  bumpPlane: number = 0;
  cameraViewAngle: number = 0;
  dof: number = 0;
  doBumping: number = 0;
  player: ModuleMGPlayer;

  farClip: number = 0;
  lateralAccel: number = 0;
  movementPerSec: number = 0;
  music: number = 0;
  nearClip: number = 0;
  useInertia: number = 0;

  enemies: ModuleMGEnemy[] = [];
  obstacles: ModuleMGObstacle[] = [];
  tracks: ModuleMGTrack[] = [];

  /** Seconds the minigame has been ticking (unpaused). */
  elapsed: number = 0;

  /** The minigame's last-values record (see IMiniGameEventContext). */
  context: IMiniGameEventContext = ModuleMiniGame.EmptyContext();
  /** Number of minigame handlers on the stack (0 = no event is being handled). */
  private contextDepth: number = 0;
  /** Serial of the latest contact; colliding objects carry `mgContact` for the contact they are in. */
  private contactSerial: number = 0;

  private obstacleTemplates: GFFObject[] = [];
  private heartbeatTimers: Map<ModuleObject, number> = new Map();
  private created: Set<ModuleObject> = new Set();

  constructor(struct: GFFStruct){
    this.bumpPlane = struct.getFieldByLabel('Bump_Plane').getValue();
    this.cameraViewAngle = struct.getFieldByLabel('CameraViewAngle').getValue();
    this.dof = struct.getFieldByLabel('DOF').getValue();
    this.doBumping = struct.getFieldByLabel('DoBumping').getValue();
    this.farClip = struct.getFieldByLabel('Far_Clip').getValue();
    this.lateralAccel = struct.getFieldByLabel('LateralAccel').getValue();
    this.movementPerSec = struct.getFieldByLabel('MovementPerSec').getValue();
    this.music = struct.getFieldByLabel('Music').getValue();
    this.nearClip = struct.getFieldByLabel('Near_Clip').getValue();
    this.type = struct.getFieldByLabel('Type').getValue();
    this.useInertia = struct.getFieldByLabel('UseInertia').getValue();

    this.player = new ModuleMGPlayer(
      GFFObject.FromStruct(struct.getFieldByLabel('Player').getChildStructs()[0])
    );
    this.player.miniGame = this;
    // ARE LateralAccel is the swoop's steering rate until a script sets one (SWMG_SetLateralAccelerationPerSecond).
    this.player.accel_lateral_secs = this.lateralAccel || 0;

    const enemies = struct.getFieldByLabel('Enemies').getChildStructs();
    for(let i = 0; i < enemies.length; i++){
      const enemy = new ModuleMGEnemy(
        GFFObject.FromStruct(enemies[i])
      );
      enemy.miniGame = this;
      this.enemies.push(enemy);
    }

    if(struct.hasField('Obstacles')){
      const obstacles = struct.getFieldByLabel('Obstacles').getChildStructs();
      for(let i = 0; i < obstacles.length; i++){
        this.obstacleTemplates.push(
          GFFObject.FromStruct(obstacles[i])
        );
      }
    }
  }

  static EmptyContext(): IMiniGameEventContext {
    return {
      event: '',
      modelName: '',
      hitTarget: undefined,
      followerHit: undefined,
      obstacleHit: undefined,
      bullet: undefined,
      bulletHitDamage: 0,
      bulletHitTarget: 0,
      bulletHitShooter: undefined,
      bulletHitPart: '',
      bulletFiredDamage: 0,
      bulletFiredTarget: 0,
      hpChange: 0,
    };
  }

  /**
   * Advance the minigame. Long frames are split into steps of at most MAX_STEP so
   * collisions, bullets and laps stay consistent; a hitch longer than MAX_FRAME
   * (a backgrounded tab, a debugger pause) only advances MAX_FRAME, like a pause.
   */
  tick(delta: number = 0){
    let remaining = Math.min(Math.max(0, delta), ModuleMiniGame.MAX_FRAME);
    while(remaining > 1e-9){
      const step = Math.min(remaining, ModuleMiniGame.MAX_STEP);
      remaining -= step;
      this.step(step);
    }
    // Steering is held input: it applies for the whole frame, then must be re-sent.
    this.player.lateralInput = 0;
  }

  private step(delta: number){
    this.elapsed += delta;

    const player = this.player;
    const from = player.getWorldSphere().center.clone();
    const followersFrom = new Map<ModuleMGEnemy, THREE.Vector3>();
    for(const enemy of this.enemies){
      followersFrom.set(enemy, enemy.getWorldSphere().center.clone());
    }
    player.stepBreaks = [];
    player.update(delta);

    for(const enemy of this.enemies.slice()){
      enemy.update(delta);
    }

    for(const obstacle of this.obstacles.slice()){
      obstacle.update(delta);
    }

    if(this.type == MiniGameType.SWOOPRACE){
      this.updatePlayerCollisions(this.getPlayerPath(from), followersFrom);
    }

    this.updateHeartbeats(delta);
  }

  /**
   * The player's path over the step as segments, cut at track discontinuities:
   * - an unanimated track records the exact end/start points of each lap reset (stepBreaks);
   * - an animated track's animation manager poses the rider before advancing its clock, so
   *   the visible jump back to the start is the step after the manager wraps
   *   (`player.trackPoseJump`); that step's two ends are tested, not the path between them.
   */
  getPlayerPath(from: THREE.Vector3): [THREE.Vector3, THREE.Vector3][] {
    const player = this.player;
    const to = player.getWorldSphere().center.clone();
    const segments: [THREE.Vector3, THREE.Vector3][] = [];
    let cursor = from;
    for(const cut of player.stepBreaks){
      segments.push([cursor, cut.end]);
      cursor = cut.start;
    }
    segments.push([cursor, to]);

    if(!player.stepBreaks.length && player.trackPoseJump){
      return [[from, from], [to, to]];
    }
    return segments;
  }

  /**
   * Swoop collisions: entering a follower's or obstacle's sphere fires the player's
   * OnHitFollower/OnHitObstacle, then the other object's OnHitFollower. Each contact
   * fires once until the spheres separate again, and carries a contact serial
   * (`mgContact`) so the default response runs once per contact. Airborne players
   * clear obstacles, and a player killed by one contact gets no further ones.
   *
   * Obstacles are static: the player's path segments are swept against them.
   * Followers move too, so their test uses the relative motion over the step (a
   * follower trailing the player at the same speed never "touches" it). When the
   * player's path is cut by a lap reset, a parked follower is swept like an obstacle and
   * a moving one is compared at end positions; on the step where the follower's own track
   * animation visibly jumps back to its start (the update after its manager wraps), only
   * end positions are compared.
   */
  updatePlayerCollisions(
    path: [THREE.Vector3, THREE.Vector3][] = [[this.player.getWorldSphere().center.clone(), this.player.getWorldSphere().center.clone()]],
    followersFrom: Map<ModuleMGEnemy, THREE.Vector3> = new Map()
  ){
    const player = this.player;
    if(!player || !player.alive){ return; }
    const radius = player.getCollisionRadius();
    const line = new THREE.Line3();
    const closest = new THREE.Vector3();
    const origin = new THREE.Vector3();
    const sweeps = (sphere: THREE.Sphere) => path.some(([a, b]) => {
      line.set(a, b);
      return line.closestPointToPoint(sphere.center, true, closest).distanceTo(sphere.center) <= radius + sphere.radius;
    });
    const continuous = path.length === 1;
    const to = path[path.length - 1][1];

    for(const enemy of this.enemies.slice()){
      if(!player.alive){ return; }
      const enemySphere = enemy.getWorldSphere();
      const f1 = enemySphere.center;
      const f0 = followersFrom.get(enemy) ?? f1;
      const moved = f0.distanceTo(f1);
      const followerJumped = enemy.trackPoseJump;
      let reached: boolean;
      if(followerJumped){
        reached = to.distanceTo(f1) <= radius + enemySphere.radius;
      }else if(continuous){
        line.set(path[0][0].clone().sub(f0), path[0][1].clone().sub(f1));
        reached = line.closestPointToPoint(origin, true, closest).length() <= radius + enemySphere.radius;
      }else if(moved < 1e-6){
        reached = sweeps(enemySphere); // a parked follower is static, like an obstacle
      }else{
        reached = to.distanceTo(f1) <= radius + enemySphere.radius;
      }
      const touching = enemy.alive && !player.isAirborne() && reached;
      if(touching && !enemy.collided){
        enemy.collided = true;
        (enemy as any).mgContact = ++this.contactSerial;
        player.onHitFollower(enemy);
        if(this.enemies.includes(enemy) && player.alive){
          enemy.onHitFollower(player);
        }
      }else if(!touching){
        enemy.collided = false;
      }
    }

    for(const obstacle of this.obstacles.slice()){
      if(!player.alive){ return; }
      const touching = !player.isAirborne() && sweeps(obstacle.getWorldSphere());
      if(touching && !obstacle.collided){
        obstacle.collided = true;
        (obstacle as any).mgContact = ++this.contactSerial;
        player.onHitObstacle(obstacle);
        if(this.obstacles.includes(obstacle) && player.alive){
          obstacle.onHitFollower(player);
        }
      }else if(!touching){
        obstacle.collided = false;
      }
    }
  }

  tickPaused(delta: number = 0){
    this.player.updatePaused(delta);

    for(let i = 0; i < this.enemies.length; i++){
      this.enemies[i].updatePaused(delta);
    }

    for(let i = 0; i < this.obstacles.length; i++){
      this.obstacles[i].updatePaused(delta);
    }
  }

  /**
   * Input resumes after a pause or a menu: a fire/shift key still held from before must
   * be released and pressed again before it acts.
   */
  resumeInput(){
    this.player.shootNeedsRelease = true;
  }

  /**
   * Run an object's minigame script. The event's own values (`context`) are written
   * into the minigame's last-values record, which keeps everything else from earlier
   * events; on return only `event`/`modelName` revert to the enclosing handler's, so
   * values a nested event wrote stay visible. When the object has no script for the
   * event, `fallback` (the engine default, also reachable from scripts through
   * SWMG_OnBulletHit/OnObstacleHit/OnDamage/OnDeath) runs instead.
   */
  dispatchEvent(
    object: ModuleObject,
    scriptKey: string,
    context: Partial<IMiniGameEventContext> = {},
    fallback?: () => void
  ): boolean {
    if(!object){ return false; }
    // Hit events name the model that was hit into (or the bullet); other events name the object's own model.
    const other: any = context.obstacleHit === object ? context.followerHit : (context.obstacleHit ?? context.followerHit);
    const modelName = context.bullet ? (context.bullet.model_name || '').toLowerCase()
      : other ? (other.getEventModelName?.() ?? '')
      : ((object as any).getEventModelName?.() ?? '');
    const record = this.context;
    const previousEvent = record.event;
    const previousModelName = record.modelName;
    Object.assign(record, { event: scriptKey, modelName }, context);
    this.contextDepth++;
    try{
      const instance = object.scripts?.[scriptKey];
      if(!instance){
        fallback?.();
        return false;
      }
      instance.mgFollower = record.followerHit;
      instance.mgObstacle = record.obstacleHit;
      instance.mgBullet = record.bullet;
      instance.run(object, 0);
      return true;
    }finally{
      this.contextDepth--;
      record.event = previousEvent;
      record.modelName = previousModelName;
    }
  }

  /**
   * Replay `body` against a captured snapshot (a DelayCommand scheduled inside a
   * handler), then put the live last-values record back.
   */
  runInContext<T>(context: IMiniGameEventContext, body: () => T): T {
    const previous = this.context;
    this.context = context;
    this.contextDepth++;
    try{
      return body();
    }finally{
      this.contextDepth--;
      this.context = previous;
    }
  }

  /**
   * Snapshot of the running handler's values, for work a script schedules from inside
   * it (DelayCommand), so SWMG_GetLast* still describe that event when it runs.
   */
  captureContext(): IMiniGameEventContext | undefined {
    return this.contextDepth > 0 ? { ...this.context } : undefined;
  }

  /** Shared damage path for bullets, obstacle bumps and scripts. Returns true if damage was applied. */
  applyDamage(target: IMiniGameCombatant, amount: number = 0): boolean {
    if(!target || !target.alive || !(amount > 0)){ return false; }
    if(target.invince > 0){ return false; }
    target.hit_points -= amount;
    this.dispatchEvent(target, ModuleObjectScript.MGPlayerOnDamage, { hpChange: -amount }, () => target.defaultOnDamage());
    if(target.hit_points <= 0){
      this.kill(target);
    }
    return true;
  }

  /**
   * Set or adjust hit points from script. Death fires once if the result is <= 0.
   * Inside a handler the change becomes SWMG_GetLastHPChange; outside any handler it is not recorded.
   */
  adjustHitPoints(target: IMiniGameCombatant, amount: number = 0, absolute: boolean = false): number {
    if(!target){ return 0; }
    const before = target.hit_points || 0;
    target.hit_points = absolute ? amount : before + amount;
    if(this.contextDepth > 0){
      this.context.hpChange = target.hit_points - before;
    }
    if(target.hit_points <= 0 && target.alive && (target.max_hps > 0 || before > 0)){
      this.kill(target);
    }
    return target.hit_points;
  }

  /** OnDeath inherits the last values of the damage that caused it (hp change, bullet, shooter). */
  kill(target: IMiniGameCombatant){
    if(!target || !target.alive){ return; }
    target.alive = false;
    this.dispatchEvent(target, ModuleObjectScript.MGPlayerOnDeath, {}, () => target.defaultOnDeath());
  }
  updateHeartbeats(delta: number = 0){
    const objects: ModuleObject[] = [this.player, ...this.enemies, ...this.obstacles];
    for(const object of objects){
      if(!object || !this.created.has(object)){ continue; }
      let timer = (this.heartbeatTimers.get(object) || 0) + delta;
      while(timer >= ModuleMiniGame.HEARTBEAT_INTERVAL){
        timer -= ModuleMiniGame.HEARTBEAT_INTERVAL;
        this.dispatchEvent(object, ModuleObjectScript.MGPlayerOnHeartbeat);
      }
      this.heartbeatTimers.set(object, timer);
    }
  }

  async load(){
    try { await this.loadMGTracks(); } catch(e){ console.error(e); }
    try { await this.loadMGPlayer(); } catch(e){ console.error(e); }
    try { await this.loadMGEnemies(); } catch(e){ console.error(e); }
    try { await this.loadMGObstacles(); } catch(e){ console.error(e); }
  }

  /** Runs OnCreate once per object (enemies, obstacles, then player) and starts its heartbeat. */
  initMiniGameObjects(){
    const objects: ModuleObject[] = [...this.enemies, ...this.obstacles, this.player];
    for(const object of objects){
      if(!object || this.created.has(object)){ continue; }
      (object as any).miniGame = this;
      this.created.add(object);
      this.heartbeatTimers.set(object, 0);
      this.dispatchEvent(object, ModuleObjectScript.MGPlayerOnCreate);
    }
  }

  async loadMGPlayer(): Promise<void> {
    console.log('Loading MG Player')
    const player: ModuleMGPlayer = this.player;
      await player.load();
      await player.loadCamera();
      await player.loadModel();
      await player.loadGunBanks();
      const track = this.tracks.find(o => o.track === player.trackName);
      if(track?.model){
        player.setTrack(track.model);
      }else{
        console.warn(`ModuleMiniGame.loadMGPlayer: Failed to resolve track [${player.trackName}]`);
      }
      player.computeBoundingBox(true);
      player.getCurrentRoom();
  }

  async loadMGTracks(): Promise<void>{
    for(let i = 0; i < this.tracks.length; i++){
      const track = this.tracks[i];
      await track.load();
      const model = await track.loadModel();
      track.model = model;
      model.userData.moduleObject = track;
      model.userData.index = i;
      //model.quaternion.setFromAxisAngle(new THREE.Vector3(0,0,1), -Math.atan2(spawnLoc.XOrientation, spawnLoc.YOrientation));
      model.hasCollision = true;
      GameState.group.creatures.add( track.model );

      track.computeBoundingBox();
      track.getCurrentRoom();
    }
  }

  async loadMGEnemies(): Promise<void> {
    for(let i = 0; i < this.enemies.length; i++){
      const enemy = this.enemies[i];
      await enemy.load();
      await enemy.loadModel();
      await enemy.loadGunBanks();
      const track = this.tracks.find(o => o.track === enemy.trackName);
      if(track?.model){
        enemy.setTrack(track.model);
      }else{
        console.warn(`ModuleMiniGame.loadMGEnemies: Failed to resolve track [${enemy.trackName}]`);
      }
      enemy.computeBoundingBox();
      enemy.getCurrentRoom();
    }
  }

  async loadMGObstacles(): Promise<void> {
    for(let i = 0; i < this.obstacles.length; i++){
      const obstacle = this.obstacles[i];
      obstacle.miniGame = this;
      const template = this.getObstacleTemplate(i, obstacle);
      if(template && obstacle.template !== template){
        obstacle.setTemplate(template);
      }
      await obstacle.load();
    }
  }

  private getObstacleTemplate(index: number, obstacle: ModuleMGObstacle): GFFObject | undefined {
    const obstacleName = this.normalizeResRef(obstacle?.layout?.name || obstacle?.name || '');

    if(obstacleName.length){
      const matchingTemplate = this.obstacleTemplates.find((template) => {
        if(!template?.RootNode?.hasField('Name')){ return false; }
        return this.normalizeResRef(template.getFieldByLabel('Name').getValue()) === obstacleName;
      });

      if(matchingTemplate){
        return matchingTemplate;
      }
    }

    return this.obstacleTemplates[index];
  }

  private normalizeResRef(value: string = ''): string {
    return value.replace(/\0[\s\S]*$/g,'').toLowerCase().trim();
  }

  /**
   * Called from ModuleArea.runStartScripts after initMiniGameObjects. OnCreate is
   * idempotent per object, so this only covers objects that were not created yet
   * (previously it re-ran every enemy's OnCreate a second time).
   */
  runMiniGameScripts(){
    this.initMiniGameObjects();
  }

  getObjectByName(name: string = ''): ModuleObject | undefined {
    const wanted = this.normalizeResRef(name);
    if(!wanted.length){ return undefined; }
    const objects: ModuleObject[] = [this.player, ...this.enemies, ...this.obstacles];
    return objects.find((object) => object && this.normalizeResRef(object.name || '') === wanted);
  }

  /** SWMG_DestroyMiniGameObject: removes a follower/obstacle (and its bullets) from play. */
  destroyObject(object: ModuleObject): boolean {
    let removed = false;
    const enemyIndex = this.enemies.indexOf(object as ModuleMGEnemy);
    if(enemyIndex >= 0){
      this.enemies.splice(enemyIndex, 1);
      removed = true;
    }
    const obstacleIndex = this.obstacles.indexOf(object as ModuleMGObstacle);
    if(obstacleIndex >= 0){
      this.obstacles.splice(obstacleIndex, 1);
      removed = true;
    }
    if(!removed){ return false; }
    const banks: any[] = (object as any).gunBanks || [];
    for(const bank of banks){
      bank.clearBullets?.();
    }
    this.created.delete(object);
    this.heartbeatTimers.delete(object);
    (object as any).alive = false;
    object.container?.removeFromParent();
    (object as any).sphere_geom?.removeFromParent?.();
    return true;
  }

  setCameraClip(near: number, far: number){
    this.nearClip = near;
    this.farClip = far;
    const camera = GameState.camera as THREE.PerspectiveCamera | undefined;
    if(camera && typeof camera.updateProjectionMatrix === 'function'){
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
  }

}
