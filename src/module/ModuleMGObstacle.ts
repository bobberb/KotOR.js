import { ModuleObject } from "@/module/ModuleObject";
import { ModuleObjectType } from "@/enums/module/ModuleObjectType";
import { ILayoutObstacle } from "@/interface/resource/ILayoutObstacle";
import { NWScript } from "@/nwscript/NWScript";
import { NWScriptInstance } from "@/nwscript/NWScriptInstance";
import { GFFObject } from "@/resource/GFFObject";
import { ModuleObjectScript } from "@/enums/module/ModuleObjectScript";
import { GameState } from "@/GameState";
import * as THREE from "three";
import type { ModuleMiniGame } from "@/module/ModuleMiniGame";
import type { ModuleMGGunBullet } from "@/module/ModuleMGGunBullet";

/**
* ModuleMGObstacle class.
* 
* Class representing a obstacle found in minigame modules.
* 
* KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
* 
* @file ModuleMGObstacle.ts
* @author KobaltBlu <https://github.com/KobaltBlu>
* @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
* @memberof KotOR
*/
export class ModuleMGObstacle extends ModuleObject {
  /** Collision radius used when no Sphere_Radius is set: LYT obstacles carry no size. */
  static readonly DEFAULT_SPHERE_RADIUS = 1;

  readonly supportsRuntimeStatePersistence: boolean = false;

  miniGame?: ModuleMiniGame;

  invince: number;
  /** Obstacles have no hit points unless a script gives them some; until then they cannot be destroyed. */
  hit_points: number = 0;
  max_hps: number = 0;
  invince_period: number = 0;
  sphere_radius: number = ModuleMGObstacle.DEFAULT_SPHERE_RADIUS;
  num_loops: number = 0;
  alive: boolean = true;
  /** True while the player is inside this obstacle's sphere (hit events fire on entry). */
  collided: boolean = false;
  layout: ILayoutObstacle;

  constructor(template: GFFObject | undefined, layout: ILayoutObstacle){
    super();
    this.objectType |= ModuleObjectType.ModuleMGObstacle;
    this.name = '';
    this.invince = 0;
    this.layout = layout;
    this.position.copy(layout.position);

    if(template){
      this.template = template;
      this.initProperties();
      this.loadScripts();
    }
  }

  setTemplate(template: GFFObject){
    this.template = template;
    this.initProperties();
    this.loadScripts();
  }

  async load(): Promise<void> {
    if(this.layout?.position){
      this.position.copy(this.layout.position);
    }

    if(this.template){
      this.initProperties();
      this.loadScripts();
    }else{
      this.name = this.layout?.name?.replace(/\0[\s\S]*$/g,'').toLowerCase() || '';
      this.initialized = true;
    }
  }

  getMiniGame(): ModuleMiniGame | undefined {
    return this.miniGame ?? GameState.module?.area?.miniGame;
  }

  getCollisionRadius(): number {
    return this.sphere_radius || 0;
  }

  getWorldSphere(): THREE.Sphere {
    this.container.getWorldPosition(this.sphere.center);
    this.sphere.radius = this.getCollisionRadius();
    return this.sphere;
  }

  getEventModelName(): string {
    return this.name || '';
  }

  update(delta: number = 0){

    this.invince -= delta;
    if(this.invince < 0) this.invince = 0;

  }

  updatePaused(delta: number = 0){

  }

  damage(damage = 0){
    if(!(this.hit_points > 0)){ return; }
    this.getMiniGame()?.applyDamage(this, damage);
  }

  adjustHitPoints(nHP = 0, nAbsolute = 0){
    return this.getMiniGame()?.adjustHitPoints(this, nHP, !!nAbsolute) ?? this.hit_points;
  }

  startInvulnerability(){
    this.invince = this.invince_period || 0;
  }

  defaultOnDamage(){

  }

  defaultOnDeath(){

  }

  onAnimEvent(event: string = '', modelName: string = this.getEventModelName()){
    this.getMiniGame()?.dispatchEvent(this, ModuleObjectScript.MGObstacleOnAnimEvent, { event, modelName });
  }

  onCreate(){
    this.getMiniGame()?.dispatchEvent(this, ModuleObjectScript.MGObstacleOnCreate);
  }

  onHitBullet(bullet: ModuleMGGunBullet){
    this.getMiniGame()?.dispatchEvent(this, ModuleObjectScript.MGObstacleOnHitBullet, bullet.getHitContext(this), () => this.damage(bullet.damage_amt));
  }

  /** The player (a follower of its own track) ran into this obstacle. */
  onHitFollower(follower?: ModuleObject){
    this.getMiniGame()?.dispatchEvent(this, ModuleObjectScript.MGObstacleOnHitFollower, { followerHit: follower });
  }

  loadScripts(){
    const scriptKeys = [
      ModuleObjectScript.MGObstacleOnAnimEvent,
      ModuleObjectScript.MGObstacleOnCreate,
      ModuleObjectScript.MGObstacleOnHeartbeat,
      ModuleObjectScript.MGObstacleOnHitBullet,
      ModuleObjectScript.MGObstacleOnHitFollower,
    ];

    const scriptsNode = this.template?.getFieldByLabel('Scripts')?.getFieldStruct();
    if(!scriptsNode){ return; }

    for(const scriptKey of scriptKeys){
      if(!scriptsNode.hasField(scriptKey)){ continue; }
      const resRef = scriptsNode.getFieldByLabel(scriptKey).getValue();
      if(!resRef){ continue; }
      const nwscript = GameState.NWScript.Load(resRef);
      if(!nwscript){ 
        console.warn(`ModuleMGObstacle.loadScripts: Failed to load script [${scriptKey}]:${resRef} for object ${this.name}`);
        continue; 
      }
      nwscript.caller = this;
      this.scripts[scriptKey] = nwscript;
    }

  }

  initProperties(){
    this.position.copy(this.layout.position);
    this.name = this.layout?.name?.replace(/\0[\s\S]*$/g,'').toLowerCase() || '';

    if(this.template?.RootNode?.hasField('Name'))
      this.name = this.template.getFieldByLabel('Name').getValue().replace(/\0[\s\S]*$/g,'').toLowerCase();

    this.initialized = true;
  }


}
