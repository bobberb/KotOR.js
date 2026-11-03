import { ModuleObject } from "@/module/ModuleObject";
import { GFFObject } from "@/resource/GFFObject";
import * as THREE from "three";
import { GameState } from "@/GameState";
import { OdysseyModel3D, OdysseyObject3D } from "@/three/odyssey";
import { Utility } from "@/utility/Utility";
import { OdysseyModel, OdysseyModelAnimationManager } from "@/odyssey";
import { NWScriptInstance } from "@/nwscript/NWScriptInstance";
// import { NWScript } from "@/nwscript/NWScript";
import { IModelListItem } from "@/interface/module/minigame/IModelListItem";
import { MiniGameType } from "@/enums/engine/MiniGameType";
import { ModuleObjectType } from "@/enums/module/ModuleObjectType";
import { MDLLoader } from "@/loaders";
import type { ModuleRoom } from "@/module/ModuleRoom";
import { ModuleMGGunBank } from "@/module/ModuleMGGunBank";
import type { ModuleMGGunBullet } from "@/module/ModuleMGGunBullet";
import type { ModuleMGEnemy } from "@/module/ModuleMGEnemy";
import type { ModuleMGObstacle } from "@/module/ModuleMGObstacle";
import { ModuleObjectScript } from "@/enums/module/ModuleObjectScript";
import type { ModuleMiniGame } from "@/module/ModuleMiniGame";

/**
* ModuleMGPlayer class.
* 
* Class representing the player in minigame modules.
* 
* KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
* 
* @file ModuleMGPlayer.ts
* @author KobaltBlu <https://github.com/KobaltBlu>
* @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
* @memberof KotOR
*/
export class ModuleMGPlayer extends ModuleObject {
  /** Swoop gear count; each gear unlocks an equal slice of Minimum_Speed..Maximum_Speed. */
  static readonly GEAR_COUNT = 5;
  static readonly JUMP_GRAVITY = 9.8;
  /** Upshifting is allowed once speed reaches this fraction of the current gear's top speed. */
  static readonly SHIFT_WINDOW = 0.9;

  readonly supportsRuntimeStatePersistence: boolean = false;

  miniGame?: ModuleMiniGame;

  camera: OdysseyModel3D;
  models: OdysseyModel3D[] = [];
  track: OdysseyObject3D;
  animationManagers: OdysseyModelAnimationManager[];
  lastRoom: ModuleRoom;
  gun_hook: THREE.Object3D;

  gunBanks: ModuleMGGunBank[] = [];
  bullets: ModuleMGGunBullet[] = [];

  //debug sphere
  sphere_geom: THREE.Mesh;

  modelProps: IModelListItem[] = [];
  no_rotate: THREE.Group;
  speed_min: number;
  speed_max: number;
  accel_secs: number;
  accel_lateral_secs: number;
  invince: number;
  gear: number;
  gunTimer: number;
  jumpSpeed: number = 0;
  jumpVelocity: number = 0;
  jumpHeight: number = 0;
  externalForce: THREE.Vector3 = new THREE.Vector3();
  falling: boolean;
  alive: boolean;
  /** Tunnel limits in radians (templates and scripts use degrees). */
  tunnel: { neg: { x: number; y: number; z: number; }; pos: { x: number; y: number; z: number; }; };
  tunnelInfinite: { x: number; y: number; z: number; } = { x: 0, y: 0, z: 0 };
  hit_points: number;
  max_hps: number;
  onCreateRun: boolean;
  sphere_radius: number;
  invince_period: number;
  bump_damage: number;
  cameraRotate: any;
  num_loops: number;

  /**
   * Swoop steering: -1/0/1 held input for this frame (cleared by ModuleMiniGame.tick),
   * current lateral velocity, and the lane centre on world X.
   */
  lateralInput: number = 0;
  lateralVelocity: number = 0;
  laneOriginX: number = 0;

  /** Gear-shift key state, so a held key (or OS key repeat) shifts once per press. */
  shiftHeld: boolean = false;
  /** After a pause or menu, MGshoot must be released before it acts again. */
  shootNeedsRelease: boolean = false;

  /** Rider time along an animated track (seconds of animation), for lap counting. */
  trackTime: number = 0;

  /** Lap resets during the current step: where the swoop left the track and where it re-entered. */
  stepBreaks: { end: THREE.Vector3; start: THREE.Vector3 }[] = [];
  /**
   * The animated track's animation manager wrapped during the previous update. It poses
   * the rider before advancing its clock, so the visible jump back to the start happens
   * on the update after the wrap: `trackPoseJump` marks that step.
   */
  trackWrappedLastUpdate: boolean = false;
  trackPoseJump: boolean = false;

  /** Contacts whose default obstacle response already ran: object -> contact serial. */
  handledContacts: Map<ModuleObject, number> = new Map();

  /** Swoop track progress: distance along the track, its length, and lap timing. */
  trackDistance: number = 0;
  trackLength: number = 0;
  loopsCompleted: number = 0;
  lapStartTime: number = 0;
  lapTimes: number[] = [];
  finishTime: number = -1;

  cameraName: string = '';
  trackName: string = '';

  constructor(template: GFFObject){
    super();
    this.objectType |= ModuleObjectType.ModuleMGPlayer;
    console.log('ModuleMGPlayer', template, this);
    this.template = template;

    this.camera = null;
    this.gunBanks = [];
    this.modelProps = [];
    this.track = new OdysseyObject3D();
    this.model = this.container as any;

    this.bullets = [];

    this.no_rotate = new THREE.Group();

    this.animationManagers = [];

    this.speed = 0;
    this.speed_min = 0;
    this.speed_max = 0;
    this.accel_secs = 0;
    this.accel_lateral_secs = 0;
    this.invince = 0;

    this.gear = 0;
    this.gunTimer = 0;
    this.falling = true;
    this.alive = true;

    this.tunnel = {
      neg: {x: 0, y: 0, z: 0},
      pos: {x: 0, y: 0, z: 0}
    }

    this.setTrack(this.track);

    const geometry = new THREE.SphereGeometry( 1, 16, 16 );
    const material = new THREE.MeshBasicMaterial( { color: 0x0000FF } );
    material.transparent = true;
    material.opacity = 0.15;
    this.sphere_geom = new THREE.Mesh( geometry, material );

  }

  canMove(){
    return false;
  }

  getHP(){
    return this.hit_points;
  }

  getMaxHP(){
    return this.max_hps;
  }

  setTrack(model = new OdysseyObject3D()){
    console.log('track', model);
    this.track = model;
    this.laneOriginX = model?.position?.x || 0;
    this.rotation.reorder('YZX');

    this.rotate('x', 0);
    this.rotate('y', 0);
    this.rotate('z', 0);

    this.container.removeFromParent();

    try{
      this.track.getObjectByName('modelhook').add(this.container);
    }catch(e){
      console.error(e);
    }

    try{
      this.track.parent.add(this.no_rotate);
      this.no_rotate.position.copy(this.track.position);
      this.no_rotate.quaternion.copy(this.track.quaternion);
    }catch(e){
      console.error(e);
    }

    this.onCreateRun = false;

    this._heartbeatTimeout = 0;

  }

  getMiniGame(): ModuleMiniGame | undefined {
    return this.miniGame ?? GameState.module?.area?.miniGame;
  }

  isAirborne(): boolean {
    return this.jumpHeight > 0;
  }

  getCollisionRadius(): number {
    return this.sphere_radius || 0;
  }

  /** Collision sphere in world space; the player rides its track's modelhook. */
  getWorldSphere(): THREE.Sphere {
    this.container.getWorldPosition(this.sphere.center);
    this.sphere.radius = this.getCollisionRadius();
    return this.sphere;
  }

  getEventModelName(): string {
    return this.models[0]?.name || this.modelProps[0]?.model?.replace(/\0[\s\S]*$/g,'').toLowerCase() || '';
  }

  /** Top speed reachable in the current gear; boosts may exceed it and decay back. */
  getGearMaxSpeed(gear: number = this.gear): number {
    if(!(this.speed_max > 0)){ return Infinity; }
    const band = (this.speed_max - this.speed_min) / ModuleMGPlayer.GEAR_COUNT;
    return this.speed_min + band * (gear + 1);
  }

  /** The track model's own animation carries the rider when it has one (as for followers). */
  isTrackAnimated(): boolean {
    const track: any = this.track;
    return track instanceof OdysseyModel3D &&
      !!(track.animationManager?.currentAnimation || track.odysseyAnimations?.length);
  }

  /** Max lateral speed: ARE MovementPerSec when set, else the lateral acceleration value. */
  getMaxLateralSpeed(): number {
    const movementPerSec = this.getMiniGame()?.movementPerSec || 0;
    return movementPerSec > 0 ? movementPerSec : (this.accel_lateral_secs || 0);
  }

  /** Steering input for this frame: -1 left, 1 right. Consumed by the next update. */
  steer(direction: number){
    this.lateralInput = Math.max(-1, Math.min(1, direction || 0));
  }

  update(delta: number = 0){
    const miniGame = this.getMiniGame();

    this.invince -= delta;
    if(this.invince < 0) this.invince = 0;

    for(let i = 0; i < this.animationManagers.length; i++){
      const aManager = this.animationManagers[i];
      if(
        aManager.currentAnimationState.loop ||
        ( !aManager.currentAnimationState.loop && !aManager.currentAnimationState.elapsedCount )
      ){
        aManager.updateAnimation(aManager.currentAnimation, aManager.currentAnimationState, delta);
      }
    }

    for(let i = 0; i < this.container.children.length; i++){
      const model = this.container.children[i];
      if(model instanceof OdysseyModel3D && model.bonesInitialized && model.visible){
        model.update(delta);
      }
    }

    this.forceVector.set(0, 0, 0);

    if(miniGame?.type == MiniGameType.SWOOPRACE && this.alive){
      this.updateSwoop(delta);
    }

    for(let i = 0; i < this.gunBanks.length; i++){
      this.gunBanks[i].update(delta);
    }

    this.getWorldSphere();
    this.sphere_geom.scale.setScalar(this.sphere_radius || 0);
    this.sphere_geom.position.copy(this.sphere.center);

    if(this.camera instanceof OdysseyModel3D && this.camera.bonesInitialized && this.camera.visible){
      this.camera.update(delta);
    }
    else if(!this.camera){
      let camerahook = this.container.getObjectByName('camerahook');
      if(camerahook)
        this.camera = camerahook.parent.parent as OdysseyModel3D;
    }

  }

  /**
   * Swoop physics: speed climbs at Accel_Secs toward the current gear's top speed
   * (boosts above it bleed off at the same rate); steering follows the ARE
   * LateralAccel/MovementPerSec/UseInertia settings and stays inside TunnelX; the
   * track animation (or, without one, an explicit trackLength) drives OnTrackLoop.
   */
  updateSwoop(delta: number){
    if(this.speed < this.speed_min){
      this.speed = this.speed_min;
    }

    const gearMax = this.getGearMaxSpeed();
    if(this.speed < gearMax){
      this.speed = Math.min(gearMax, this.speed + this.accel_secs * delta);
    }else if(this.speed > gearMax){
      this.speed = Math.max(gearMax, this.speed - this.accel_secs * delta);
    }
    if(this.speed_max > 0 && this.speed > this.speed_max){
      this.speed = this.speed_max;
    }

    this.updateLateralVelocity(delta);

    const animated = this.isTrackAnimated();
    this.forceVector.set(this.lateralVelocity * delta, animated ? 0 : this.speed * delta, 0);
    this.forceVector.add(this.externalForce);
    this.externalForce.set(0, 0, 0);

    if(this.jumpHeight > 0 || this.jumpVelocity > 0){
      const previousHeight = this.jumpHeight;
      this.jumpHeight += this.jumpVelocity * delta;
      this.jumpVelocity -= ModuleMGPlayer.JUMP_GRAVITY * delta;
      if(this.jumpHeight <= 0){
        this.jumpHeight = 0;
        this.jumpVelocity = 0;
      }
      this.position.z += this.jumpHeight - previousHeight;
    }

    this.track.position.add(this.forceVector);
    this.clampLateral();
    this.track.updateMatrixWorld();

    if(animated){
      this.advanceTrackAnimation(delta);
      return;
    }

    this.trackDistance += this.forceVector.y;
    if(this.trackLength > 0){
      while(this.trackDistance >= this.trackLength){
        // Record the cut so collisions sweep up to the finish and on from the start, not across the course.
        const end = this.container.getWorldPosition(new THREE.Vector3());
        end.y -= this.trackDistance - this.trackLength;
        this.stepBreaks.push({ end, start: end.clone().setY(end.y - this.trackLength) });
        this.trackDistance -= this.trackLength;
        this.track.position.y -= this.trackLength;
        this.track.updateMatrixWorld();
        this.completeLoop();
      }
    }
  }

  /**
   * Without inertia the swoop slides sideways at full lateral speed while steering and
   * stops when released; with UseInertia it accelerates/decelerates at LateralAccel.
   * The input stays set for the whole frame (all sub-steps); ModuleMiniGame.tick clears it.
   */
  updateLateralVelocity(delta: number){
    const input = this.lateralInput;
    const maxSpeed = this.getMaxLateralSpeed();
    if(!this.getMiniGame()?.useInertia){
      this.lateralVelocity = input * maxSpeed;
      return;
    }
    const accel = this.accel_lateral_secs || 0;
    if(input){
      this.lateralVelocity += input * accel * delta;
    }else if(this.lateralVelocity > 0){
      this.lateralVelocity = Math.max(0, this.lateralVelocity - accel * delta);
    }else{
      this.lateralVelocity = Math.min(0, this.lateralVelocity + accel * delta);
    }
    this.lateralVelocity = Math.max(-maxSpeed, Math.min(maxSpeed, this.lateralVelocity));
  }

  /**
   * Keep the swoop inside the X tunnel limits (TunnelXNeg..TunnelXPos, in track units
   * from the lane centre along world X) unless X is infinite. Reads the live limits, so
   * SWMG_SetPlayerTunnelNeg/Pos take effect.
   */
  clampLateral(){
    const neg = THREE.MathUtils.radToDeg(this.tunnel.neg.x);
    const pos = THREE.MathUtils.radToDeg(this.tunnel.pos.x);
    if(this.tunnelInfinite.x || (neg === 0 && pos === 0) || neg > pos){ return; }
    const offset = this.track.position.x - this.laneOriginX;
    const clamped = Math.max(neg, Math.min(pos, offset));
    if(clamped !== offset){
      this.track.position.x = this.laneOriginX + clamped;
      this.lateralVelocity = 0;
    }
  }

  /**
   * Animation playback rate for an animated track: speed / Maximum_Speed. Without a
   * Maximum_Speed the track runs at full rate while the swoop moves and stops at speed 0.
   */
  getTrackRate(): number {
    if(this.speed_max > 0){ return Math.max(0, this.speed / this.speed_max); }
    return this.speed > 0 ? 1 : 0;
  }

  /**
   * Play the track animation looped at the speed-scaled rate. Laps are counted from the
   * rider's accumulated animation time, not from the animation manager's wraps (it wraps
   * at most once per update and drops the remainder), so every lap is credited on time.
   * The visible pose jump is tracked separately from the manager's own wrap.
   */
  advanceTrackAnimation(delta: number){
    const track: any = this.track;
    if(!track.animationManager?.currentAnimation){
      track.playAnimation(0, true);
    }
    const step = delta * this.getTrackRate();
    const wrapsBefore = track.animationManager?.currentAnimationState?.elapsedCount || 0;
    track.update(step);
    const wrapsAfter = track.animationManager?.currentAnimationState?.elapsedCount || 0;
    this.trackPoseJump = this.trackWrappedLastUpdate;
    this.trackWrappedLastUpdate = wrapsAfter > wrapsBefore;
    const length = track.animationManager?.currentAnimation?.length || 0;
    if(!(length > 0)){ return; }
    this.trackTime += step;
    while(this.trackTime >= length - 1e-9){
      this.trackTime -= length;
      this.completeLoop();
    }
  }
  completeLoop(){
    const miniGame = this.getMiniGame();
    const now = miniGame?.elapsed ?? 0;
    this.loopsCompleted++;
    this.lapTimes.push(now - this.lapStartTime);
    this.lapStartTime = now;
    if(this.num_loops > 0 && this.loopsCompleted >= this.num_loops && this.finishTime < 0){
      this.finishTime = now;
    }
    this.onTrackLoop();
  }

  updatePaused(delta: number = 0){

  }

  damage(damage = 0){
    this.getMiniGame()?.applyDamage(this, damage);
  }

  adjustHitPoints(nHP = 0, nAbsolute = 0){
    return this.getMiniGame()?.adjustHitPoints(this, nHP, !!nAbsolute) ?? this.hit_points;
  }

  startInvulnerability(){
    this.invince = this.invince_period || 0;
  }

  playModelAnimation(name: string){
    for(const model of this.models){
      if(model instanceof OdysseyModel3D && model.bonesInitialized && model.visible){
        model.playAnimation(name, false);
      }
    }
  }

  /** Engine default for OnDamage (SWMG_OnDamage). */
  defaultOnDamage(){
    this.playModelAnimation('damage');
  }

  /** Engine default for OnDeath (SWMG_OnDeath). */
  defaultOnDeath(){
    this.playModelAnimation('die');
  }

  isAccelerator(object: ModuleObject): boolean {
    return /accel|boost/i.test(object?.name || '');
  }

  /**
   * Engine default for OnHitObstacle/OnHitFollower (SWMG_OnObstacleHit): accelerator
   * pads boost to top speed; anything else is a crash unless invulnerable: bump
   * damage, drop to minimum speed in first gear, then the invulnerability period.
   * Runs at most once per contact, so the player's and the obstacle's scripts can
   * both call the default without doubling it.
   */
  defaultObstacleHit(object?: ModuleObject){
    if(!object || object === this || !this.alive){ return; }
    const contact = (object as any).mgContact as number | undefined;
    if(contact !== undefined){
      if(this.handledContacts.get(object) === contact){ return; }
      this.handledContacts.set(object, contact);
    }
    if(this.isAccelerator(object)){
      this.boost();
      return;
    }
    if(this.invince > 0){ return; }
    this.getMiniGame()?.applyDamage(this, this.bump_damage || 0);
    if(!this.alive){ return; } // a lethal crash ends with OnDeath, not a brake
    this.speed = this.speed_min;
    this.gear = 0;
    this.startInvulnerability();
    this.onBrake();
  }

  boost(){
    this.speed = this.speed_max > 0 ? this.speed_max : this.speed + this.accel_secs;
    this.onAccelerate();
  }

  /**
   * Upshift only once speed is within SHIFT_WINDOW of the current gear's top speed,
   * so shifting has to be timed rather than mashed.
   */
  canShiftUp(): boolean {
    if(!this.alive || this.gear >= ModuleMGPlayer.GEAR_COUNT - 1){ return false; }
    const gearMax = this.getGearMaxSpeed();
    return !isFinite(gearMax) || this.speed >= gearMax * ModuleMGPlayer.SHIFT_WINDOW;
  }

  shiftGear(): boolean {
    if(!this.canShiftUp()){ return false; }
    this.gear++;
    this.onAccelerate();
    return true;
  }

  /** Shift on the press, not while held: OS key repeat must not keep shifting. */
  setShiftInput(held: boolean): boolean {
    const shifted = held && !this.shiftHeld ? this.shiftGear() : false;
    this.shiftHeld = !!held;
    return shifted;
  }

  shoot(){
    switch(this.getMiniGame()?.type){
      case MiniGameType.SWOOPRACE:
        this.shiftGear();
      break;
      case MiniGameType.TURRET:
        this.fire();
      break;
    }
  }

  /** Jumping is off until a script sets a jump speed (TSL SWMG_SetJumpSpeed). */
  jump(): boolean {
    if(!this.alive || !(this.jumpSpeed > 0) || this.isAirborne()){ return false; }
    this.jumpVelocity = this.jumpSpeed;
    return true;
  }

  applyForce(force: {x: number, y: number, z: number}){
    this.externalForce.x += force?.x || 0;
    this.externalForce.y += force?.y || 0;
    this.externalForce.z += force?.z || 0;
  }

  fire(){
    if(!this.alive){ return; }
    for(let i = 0; i < this.gunBanks.length; i++){
      this.gunBanks[i].fire();
    }
  }

  /** Turret aim: clamp each axis to its tunnel limits unless TunnelInfinite frees that axis. */
  rotate(axis = 'x', amount = 0){
    if(axis !== 'x' && axis !== 'y' && axis !== 'z'){ return; }
    const key = axis as 'x' | 'y' | 'z';
    this.rotation[key] += amount;
    if(!this.tunnelInfinite?.[key]){
      if(this.rotation[key] > this.tunnel.pos[key])
        this.rotation[key] = this.tunnel.pos[key];
      if(this.rotation[key] < this.tunnel.neg[key])
        this.rotation[key] = this.tunnel.neg[key];
    }

    this.rotation.x = Utility.NormalizeRadian(this.rotation.x);
    this.rotation.y = Utility.NormalizeRadian(this.rotation.y);
    this.rotation.z = Utility.NormalizeRadian(this.rotation.z);

  }

  playAnimation(name = '', bLooping = 0, bQueue = 0, bOverlay = 0){
    // const padding = '                                             ';
    //console.log(`play: ${name}${padding}`.substring(0, 20), `bLooping: ${bLooping ? 'true' : 'false'}${padding}`.substring(0, 20), `bQueue: ${bQueue ? 'true' : 'false'}${padding}`.substring(0, 20), `bOverlay: ${bOverlay ? 'true' : 'false'}${padding}`.substring(0, 20));
    for(let i = 0; i < this.models.length; i++){
      const model = this.models[i];
      const anim = model.odysseyAnimationMap.get(name.toLowerCase().trim());
      if(anim){

        //Check if this animation has already been applied
        const existingIndex = this.animationManagers.findIndex( am => am?.currentAnimation?.name == name );
        if(existingIndex >= 0){
          this.animationManagers.splice(existingIndex, 1);
        }

        if(bOverlay){
          const animManager = new OdysseyModelAnimationManager(model);
          const state = animManager.createAnimationState();
          state.loop = bLooping ? true : false;
          animManager.setCurrentAnimation(anim, state);
          this.animationManagers.push(animManager);
        }else{
          model.playAnimation(anim, false);
        }
      }
    }
  }

  removeAnimation(name = ''){
    // const padding = '                                             ';
    //console.log( `remove: ${name}${padding}`.substring(0, 20) );
    const existingIndex = this.animationManagers.findIndex( am => am?.currentAnimation?.name == name );
    if(existingIndex >= 0){
      this.animationManagers.splice(existingIndex, 1);
    }
  }

  updateCollision(delta = 0){

    if(!GameState.module || !GameState.module.area)
      return;

    let _axisFront = this.forceVector.clone();
    let _oPosition = this.position.clone();

    //this.getCurrentRoom();
    const hitdist = this.sphere_radius;
    const hitdist_half = hitdist/2;

    this.box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    this.box.translate(this.position);
    this.box.translate(_axisFront);

    const box = this.box.clone();

    //START Gravity
    GameState.raycaster.far = 10;
    let scratchVec3 = new THREE.Vector3(0, 0, 2);
    let playerFeetRay = this.position.clone().add( ( scratchVec3 ) );
    GameState.raycaster.ray.origin.set(playerFeetRay.x,playerFeetRay.y,playerFeetRay.z);
    GameState.raycaster.ray.direction.set(0, 0,-1);

    let obj = undefined;

    if(!this.room) this.getCurrentRoom();

    if(this.room){

      //START: PLACEABLE COLLISION
      this.tmpPos = this.position.clone().add(this.forceVector);
      let plcEdgeLines = [];
      let face;
      let edge;
      let line;
      let closestPoint = new THREE.Vector3(0, 0, 0);
      let distance;
      let plcCollision = false;
      /*for(let j = 0, jl = this.room.placeables.length; j < jl; j++){
        obj = this.room.placeables[j];
        if(obj && obj.walkmesh && obj.model && obj.model.visible){
          obj.box.setFromObject(obj.model);
          if(obj.box.intersectsBox(box) || obj.box.containsBox(box)){
            for(let l = 0, ll = obj.walkmesh.edgeKeys.length; l < ll; l++){
              edge = obj.walkmesh.edges[obj.walkmesh.edgeKeys[l]];
              edge.line.closestPointToPoint(this.tmpPos, true, closestPoint);
              distance = closestPoint.distanceTo(this.tmpPos);
              if(distance < hitdist_half){
                plcEdgeLines.push({
                  object: obj,
                  line: line,
                  closestPoint: closestPoint.clone(),
                  distance: distance,
                  maxDistance: hitdist_half,
                  position: this.position
                });
                plcCollision = true;
              }
            }
          }
        }
      }*/

      //END: PLACEABLE COLLISION
      
      //START: ROOM COLLISION
      if(!this.collisionManager.groundFace){
        this.findWalkableFace();
      }

      //room walkable edge check
      let roomCollision = false;
      for (const [index, edge] of this.room.collisionManager.walkmesh.edges) {
        if(edge && edge.transition == -1){
          edge.line.closestPointToPoint(this.tmpPos, true, closestPoint);
          distance = closestPoint.distanceTo(this.tmpPos);
          if(distance < hitdist_half){
            plcEdgeLines.push({
              object: this.room,
              line: edge.line,
              closestPoint: closestPoint.clone(),
              distance: distance,
              maxDistance: hitdist_half,
              position: this.position
            });
            roomCollision = true;
          }
        }
      }

      
        
      if(!(plcCollision && roomCollision)){
        if(plcEdgeLines.length){
          plcEdgeLines.sort((a, b) => (a.distance > b.distance) ? -1 : 1)
          let average = new THREE.Vector3();
          let edgeLine = undefined;
          let distanceOffset = 0;
          let force: THREE.Vector3;
          for(let i = 0, len = plcEdgeLines.length; i < len; i++){
            edgeLine = plcEdgeLines[i];
            distanceOffset = edgeLine.maxDistance - edgeLine.distance;
            force = edgeLine.closestPoint.clone().sub(edgeLine.position);
            force.multiplyScalar(distanceOffset * 2.5);
            force.z = 0;
            average.add( force.negate() );
          }
          this.position.copy(this.tmpPos);
          this.forceVector.copy(average.divideScalar(plcEdgeLines.length));
        }
      }else{
        this.forceVector.set(0, 0, 0);
      }
      //END: ROOM COLLISION

      //Check to see if we tp'd inside of a placeable
      if(this.forceVector.length()){
        this.tmpPos.copy(this.position).add(this.forceVector);
        for(let j = 0, jl = this.room.placeables.length; j < jl; j++){
          obj = this.room.placeables[j];
          if(obj && obj.collisionManager.walkmesh && obj.model && obj.model.visible){
            for(let i = 0, iLen = obj.collisionManager.walkmesh.faces.length; i < iLen; i++){
              face = obj.collisionManager.walkmesh.faces[i];
              if(face.triangle.containsPoint(this.tmpPos) && face.surfacemat.walk){
                //bail we should not be here
                this.forceVector.set(0, 0, 0);
                this.position.copy(_oPosition);
              }
            }
          }
        }
      
        //DETECT: ROOM TRANSITION
        for (const [index, edge] of this.room.collisionManager.walkmesh.edges) {
          if(edge && edge.transition >= 0){
            if(
              Utility.LineLineIntersection(
                this.position.x,
                this.position.y,
                this.position.x + this.forceVector.x,
                this.position.y + this.forceVector.y,
                edge.line.start.x,
                edge.line.start.y,
                edge.line.end.x,
                edge.line.end.y
              )
            ){
              this.attachToRoom(GameState.module.area.rooms[edge.transition]);
              break;
            }
          }
        }

        //update creature position
        this.position.add(this.forceVector);
        //DETECT: GROUND FACE
        this.lastRoom = this.room;
        this.collisionManager.lastGroundFace = this.collisionManager.groundFace;
        //this.groundFace = undefined;
        if(this.room){
          let face = this.room.findWalkableFace(this);
          if(!face){
            this.findWalkableFace();
          }
        }

        if(!this.collisionManager.groundFace){
          this.forceVector.set(0, 0, 0);
          this.position.copy(_oPosition);
          this.collisionManager.groundFace = this.collisionManager.lastGroundFace;
          this.attachToRoom(this.lastRoom);
          this.forceVector.set(0, 0, 0);
        }
      }
    }

    //END Gravity
    GameState.raycaster.far = Infinity;
    this.track.updateMatrixWorld();

    this.box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    this.box.translate(this.position);
    this.box.translate(this.forceVector);

  }

  getCurrentRoom(){
    if(this instanceof ModuleObject){
      this.room = undefined;
      let aabbFaces = [];
      let intersects;// = GameState.raycaster.intersectOctreeObjects( meshesSearch );
      const box = this.box.clone();

      this.rooms = [];
      this.roomIds = [];
      for(let i = 0; i < GameState.module.area.rooms.length; i++){
        let room = GameState.module.area.rooms[i];
        let model = room.model;
        if(model instanceof OdysseyModel3D){
          if(model.box.containsPoint(this.position)){
            this.roomIds.push(i);
          }
        }
      }

      if(box){
        for(let j = 0, jl = this.roomIds.length; j < jl; j++){
          let room = GameState.module.area.rooms[this.roomIds[j]];
          if(room && room.collisionManager.walkmesh && room.collisionManager.walkmesh.aabbNodes.length){
            aabbFaces.push({
              object: room, 
              faces: room.collisionManager.walkmesh.getAABBCollisionFaces(box)
            });
          }
        }
      }
      
      let scratchVec3 = new THREE.Vector3(0, 0, 2);
      let playerFeetRay = this.position.clone().add(scratchVec3);
      GameState.raycaster.ray.origin.set(playerFeetRay.x,playerFeetRay.y,playerFeetRay.z);
      GameState.raycaster.ray.direction.set(0, 0,-1);
      
      for(let j = 0, jl = aabbFaces.length; j < jl; j++){
        let castableFaces = aabbFaces[j];
        intersects = castableFaces.object.collisionManager.walkmesh.raycast(GameState.raycaster, castableFaces.faces) || [];
        
        if(intersects.length){
          if(intersects[0].object.userData.moduleObject){
            this.attachToRoom(intersects[0].object.userData.moduleObject);
            return;
          }
        }
      }
      if(this.roomIds.length){
        this.attachToRoom(GameState.module.area.rooms[this.roomIds[0]]);
        return;
      }
      this.findWalkableFace();
    }
  }

  findWalkableFace(){
    let face;
    let room;
    for(let i = 0, il = GameState.module.area.rooms.length; i < il; i++){
      room = GameState.module.area.rooms[i];
      if(room.collisionManager.walkmesh){
        for(let j = 0, jl = room.collisionManager.walkmesh.walkableFaces.length; j < jl; j++){
          face = room.collisionManager.walkmesh.walkableFaces[j];
          if(face.triangle.containsPoint(this.position)){
            this.collisionManager.groundFace = face;
            this.collisionManager.lastGroundFace = this.collisionManager.groundFace;
            this.collisionManager.surfaceId = this.collisionManager.groundFace.walkIndex;
            this.attachToRoom(room);
            face.triangle.closestPointToPoint(this.position, this.collisionManager.wm_c_point);
            this.position.z = this.collisionManager.wm_c_point.z + .005;
          }
        }
      }
    }
    return face;
  }

  async load(): Promise<void> {
    this.initProperties();
    this.loadScripts();
    GameState.scene.add(this.sphere_geom);
  }

  async loadCamera( onLoad?: Function ): Promise<void> {
    if(this.cameraName){
      const resref = this.cameraName.replace(/\0[\s\S]*$/g,'').toLowerCase();
      try{
        const mdl = await MDLLoader.loader.load(resref);
        const camera = await OdysseyModel3D.FromMDL(mdl, {
          context: this.context,
          castShadow: true,
          receiveShadow: true
        });

        this.camera = camera;
        camera.name = this.cameraName;
        this.container.add(camera);
      }catch(e){
        console.error(e);
      }
    }

    if(typeof onLoad === 'function')
      onLoad();
  }

  async loadModel (){
    for(let i = 0; i < this.modelProps.length; i++){
      try{
        const item = this.modelProps[i];
        const resref = item.model.replace(/\0[\s\S]*$/g,'').toLowerCase();
        const mdl = await MDLLoader.loader.load(resref);
        const model = await OdysseyModel3D.FromMDL(mdl, {
          context: this.context,
          castShadow: true,
          receiveShadow: true
        });
        if(item.rotating){
          this.container.add(model);
        }else{
          this.no_rotate.add(model);
        }
        this.models.push(model);
        model.name = item.model;
        this.listenForAnimEvents(model);

        if(this.camera && model.name == this.camera.name)
          model.visible = false;
      }catch(e){
        console.error(e);
      }
    }
  }

  getGunHook(bankID: number): THREE.Object3D | undefined {
    return this.container.getObjectByName('gunbank'+bankID) as THREE.Object3D;
  }

  async loadGunBanks(){
    for(let i = 0; i < this.gunBanks.length; i++){
      const gunbank = this.gunBanks[i];
      await gunbank.load();
      this.gun_hook = this.getGunHook(gunbank.bankID);
      if(this.gun_hook instanceof THREE.Object3D){
        this.gun_hook.add(gunbank.model);
      }
    }
  }

  onAnimEvent(event: string = '', modelName: string = this.getEventModelName()){
    this.getMiniGame()?.dispatchEvent(this, ModuleObjectScript.MGPlayerOnAnimEvent, { event, modelName });
  }

  onCreate(){
    this.getMiniGame()?.dispatchEvent(this, ModuleObjectScript.MGPlayerOnCreate);
  }

  onDamaged(): boolean{
    this.getMiniGame()?.dispatchEvent(this, ModuleObjectScript.MGPlayerOnDamage, {}, () => this.defaultOnDamage());
    return true;
  }

  onFire(bullet?: ModuleMGGunBullet){
    this.getMiniGame()?.dispatchEvent(this, ModuleObjectScript.MGPlayerOnFire, bullet ? {
      bulletFiredDamage: bullet.damage_amt,
      bulletFiredTarget: bullet.target_type,
    } : {});
  }

  onAccelerate(){
    this.getMiniGame()?.dispatchEvent(this, ModuleObjectScript.MGPlayerOnAccelerate);
  }

  onBrake(){
    this.getMiniGame()?.dispatchEvent(this, ModuleObjectScript.MGPlayerOnBrake);
  }

  onHitBullet( bullet: ModuleMGGunBullet ){
    this.getMiniGame()?.dispatchEvent(this, ModuleObjectScript.MGPlayerOnHitBullet, bullet.getHitContext(this), () => this.damage(bullet.damage_amt));
  }

  onHitFollower( follower: ModuleMGEnemy ){
    this.getMiniGame()?.dispatchEvent(this, ModuleObjectScript.MGPlayerOnHitFollower, { followerHit: follower, hitTarget: follower }, () => this.defaultObstacleHit(follower));
  }

  onHitObstacle( obstacle: ModuleMGObstacle ){
    this.getMiniGame()?.dispatchEvent(this, ModuleObjectScript.MGPlayerOnHitObstacle, { obstacleHit: obstacle, hitTarget: obstacle }, () => this.defaultObstacleHit(obstacle));
  }

  onTrackLoop(){
    this.getMiniGame()?.dispatchEvent(this, ModuleObjectScript.MGPlayerOnTrackLoop);
  }

  /** Model animation events (MDL event keys) raise OnAnimEvent with the event and model name. */
  listenForAnimEvents(model: THREE.Object3D){
    model?.addEventListener?.('playEvent', (e: any) => this.onAnimEvent(e?.event || '', model.name || ''));
  }

  loadScripts (){
    const scriptResRefs = [
      ModuleObjectScript.MGPlayerOnAccelerate,
      ModuleObjectScript.MGPlayerOnAnimEvent,
      ModuleObjectScript.MGPlayerOnBrake,
      ModuleObjectScript.MGPlayerOnCreate,
      ModuleObjectScript.MGPlayerOnDamage,
      ModuleObjectScript.MGPlayerOnDeath,
      ModuleObjectScript.MGPlayerOnFire,
      ModuleObjectScript.MGPlayerOnHeartbeat,
      ModuleObjectScript.MGPlayerOnHitBullet,
      ModuleObjectScript.MGPlayerOnHitFollower,
      ModuleObjectScript.MGPlayerOnHitObstacle,
      ModuleObjectScript.MGPlayerOnHitWorld,
      ModuleObjectScript.MGPlayerOnTrackLoop,
    ];

    const scriptsNode = this.template.getFieldByLabel('Scripts')?.getFieldStruct();
    if(scriptsNode){
      for(const scriptKey of scriptResRefs){
        if(scriptsNode.hasField(scriptKey)){
          const resRef = scriptsNode.getFieldByLabel(scriptKey).getValue();
          if(!resRef){ continue; }
          const nwscript = GameState.NWScript.Load(resRef);
          if(!nwscript){ 
            console.warn(`ModuleMGPlayer.loadScripts: Failed to load script [${scriptKey}]:${resRef} for object ${this.name}`);
            continue; 
          }
          nwscript.caller = this;
          this.scripts[scriptKey] = nwscript;
        }
      }
    }
  }

  initProperties(){
    this.accel_secs = 0;
    this.bump_damage = 0;
    this.cameraName = '';
    this.cameraRotate = 0;
    this.hit_points = 0;
    this.invince_period = 0;
    this.max_hps = 0;
    this.speed_max = 0;
    this.speed_min = 0;
    this.num_loops = 0;
    this.sphere_radius = 0;
    this.trackName = '';
    this.modelProps = [];
    this.gunBanks = [];
    this.tunnel.neg.x = 0;
    this.tunnel.neg.y = 0;
    this.tunnel.neg.z = 0;
    this.tunnel.pos.x = 0;
    this.tunnel.pos.y = 0;
    this.tunnel.pos.z = 0;

    if(this.template.RootNode.hasField('Accel_Secs'))
      this.accel_secs = this.template.getFieldByLabel('Accel_Secs').getValue();

    if(this.template.RootNode.hasField('Bump_Damage'))
      this.bump_damage = this.template.getFieldByLabel('Bump_Damage').getValue();

    if(this.template.RootNode.hasField('Camera'))
      this.cameraName = this.template.getFieldByLabel('Camera').getValue();

    if(this.template.RootNode.hasField('CameraRotate'))
      this.cameraRotate = this.template.getFieldByLabel('CameraRotate').getValue();

    if(this.template.RootNode.hasField('Hit_Points'))
      this.hit_points = this.template.getFieldByLabel('Hit_Points').getValue();

    if(this.template.RootNode.hasField('Invince_Period'))
      this.invince_period = this.template.getFieldByLabel('Invince_Period').getValue();

    if(this.template.RootNode.hasField('Max_HPs'))
      this.max_hps = this.template.getFieldByLabel('Max_HPs').getValue();

    if(this.template.RootNode.hasField('Maximum_Speed'))
      this.speed_max = this.template.getFieldByLabel('Maximum_Speed').getValue();

    if(this.template.RootNode.hasField('Minimum_Speed'))
      this.speed_min = this.template.getFieldByLabel('Minimum_Speed').getValue();

    if(this.template.RootNode.hasField('Num_Loops'))
      this.num_loops = this.template.getFieldByLabel('Num_Loops').getValue();

    if(this.template.RootNode.hasField('Sphere_Radius'))
      this.sphere_radius = this.template.getFieldByLabel('Sphere_Radius').getValue();

    if(this.template.RootNode.hasField('Track'))
      this.trackName = this.template.getFieldByLabel('Track').getValue().replace(/\0[\s\S]*$/g,'').toLowerCase();

    if(this.template.RootNode.hasField('TunnelXNeg'))
      this.tunnel.neg.x = THREE.MathUtils.degToRad(this.template.getFieldByLabel('TunnelXNeg').getValue());

    if(this.template.RootNode.hasField('TunnelXPos'))
      this.tunnel.pos.x = THREE.MathUtils.degToRad(this.template.getFieldByLabel('TunnelXPos').getValue());
    
    if(this.template.RootNode.hasField('TunnelYNeg'))
      this.tunnel.neg.y = THREE.MathUtils.degToRad(this.template.getFieldByLabel('TunnelYNeg').getValue());

    if(this.template.RootNode.hasField('TunnelYPos'))
      this.tunnel.pos.y = THREE.MathUtils.degToRad(this.template.getFieldByLabel('TunnelYPos').getValue());

    if(this.template.RootNode.hasField('TunnelZNeg'))
      this.tunnel.neg.z = THREE.MathUtils.degToRad(this.template.getFieldByLabel('TunnelZNeg').getValue());

    if(this.template.RootNode.hasField('TunnelZPos'))
      this.tunnel.pos.z = THREE.MathUtils.degToRad(this.template.getFieldByLabel('TunnelZPos').getValue());

    // Some retail templates spell the label with a lowercase L ("Tunnellnfinite").
    const infiniteLabel = ['TunnelInfinite', 'Tunnellnfinite'].find((label) => this.template.RootNode.hasField(label));
    if(infiniteLabel){
      const infinite = this.template.getFieldByLabel(infiniteLabel).getVector();
      this.tunnelInfinite = { x: infinite?.x || 0, y: infinite?.y || 0, z: infinite?.z || 0 };
    }

    if(this.template.RootNode.hasField('Models')){
      let models = this.template.getFieldByLabel('Models').getChildStructs();
      for(let i = 0; i < models.length; i++){
        let modelStruct = models[i];
        this.modelProps.push({
          model: modelStruct.getFieldByLabel('Model').getValue(),
          rotating: !!modelStruct.getFieldByLabel('RotatingModel').getValue()
        });
      }
    }

    if(this.template.RootNode.hasField('Gun_Banks')){
      const gun_banks = this.template.getFieldByLabel('Gun_Banks').getChildStructs();
      for(let i = 0; i < gun_banks.length; i++){
        this.gunBanks.push(
          new ModuleMGGunBank(
            GFFObject.FromStruct(gun_banks[i]),
            this,
            true
          )
        );
      }
    }

    this.initialized = true;


    /*if(this.template.RootNode.hasField('CameraRotate'))
      this.cameraRotate = this.template.getFieldByLabel('CameraRotate').getValue();

    if(this.template.RootNode.hasField('Hit_Points'))
      this.hit_points = this.template.getFieldByLabel('Hit_Points').getValue();

    if(this.template.RootNode.hasField('Invince_Period'))
      this.invince_period = this.template.getFieldByLabel('Invince_Period').getValue();

    if(this.template.RootNode.hasField('Max_HPs'))
      this.max_hps = this.template.getFieldByLabel('Max_HPs').getValue();

    if(this.template.RootNode.hasField('Maximum_Speed'))
      this.maximum_speed = this.template.getFieldByLabel('Maximum_Speed').getValue();*/



  }


}
