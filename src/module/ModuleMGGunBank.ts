import * as THREE from "three";
import { ModuleObject } from "@/module/ModuleObject";
import { GameState } from "@/GameState";
import { ModuleObjectType } from "@/enums/module/ModuleObjectType";
import { MDLLoader } from "@/loaders";
import { GFFObject } from "@/resource/GFFObject";
import { OdysseyModel3D } from "@/three/odyssey";
import { ModuleMGGunBullet } from "@/module/ModuleMGGunBullet";

/**
* ModuleMGGunBank class.
*
* Class representing a gunbank attached to players and enemy objects found in minigame modules.
*
* KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
*
* @file ModuleMGGunBank.ts
* @author KobaltBlu <https://github.com/KobaltBlu>
* @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
* @memberof KotOR
*/
export class ModuleMGGunBank extends ModuleObject {
  bullets: ModuleMGGunBullet[];
  owner: ModuleObject;
  isPlayer: boolean = false;
  fireTimer: number = 0;
  /** Bullet stats for this bank; every fired bullet copies them (scripts edit them via SWMG_SetGunBank*). */
  proto_bullet: ModuleMGGunBullet;
  fire_sound: any;
  bulletTemplate: GFFObject;
  bullet_hook: THREE.Object3D;
  gunModel: string;
  bankID: number;
  fireSound: string;
  horizSpread: number;
  inaccuracy: number;
  sensingRadius: number;
  vertSpread: number;
  /** Whether the bank currently has the player in its line of fire (SWMG_IsGunBankTargetting). */
  targetting: boolean = false;

  constructor( template: GFFObject, owner: ModuleObject, isPlayer: boolean = false ){
    super();
    this.objectType |= ModuleObjectType.ModuleMGGunBank;
    this.template = template;
    this.bullets = [];
    this.owner = owner;
    this.isPlayer = isPlayer;

    this.proto_bullet = undefined;

  }

  update(delta = 0){
    //Update the gun timer
    if(this.fireTimer > 0){
      this.fireTimer -= 1 * delta;
      if(this.fireTimer < 0){
        this.fireTimer = 0;
      }
    }else{
      this.fireTimer = 0;
    }

    if(this.model instanceof OdysseyModel3D) this.model.update(delta);

    for(const bullet of this.bullets.slice()){
      if(!bullet.update(delta)){
        const index = this.bullets.indexOf(bullet);
        if(index >= 0){
          this.bullets.splice(index, 1);
        }
      }
    }
  }

  updatePaused(delta: number = 0){

  }

  /** World-space muzzle position and firing direction (bullets travel along the owner's local +Y). */
  getMuzzle(position: THREE.Vector3, direction: THREE.Vector3, quaternion: THREE.Quaternion = new THREE.Quaternion()){
    const origin = this.bullet_hook || this.owner?.container;
    if(origin){
      origin.getWorldPosition(position);
    }else{
      position.set(0, 0, 0);
    }
    if(this.owner?.container){
      this.owner.container.getWorldQuaternion(quaternion);
    }else{
      quaternion.identity();
    }
    direction.set(0, 1, 0).applyQuaternion(quaternion);
  }

  /** True when a bullet fired now would travel through the target's collision sphere within sensing range. */
  canSee(target: ModuleObject & { getWorldSphere(): THREE.Sphere }): boolean {
    if(!target){ return false; }
    const sphere = target.getWorldSphere();
    if(!(sphere.radius > 0)){ return false; }
    const position = new THREE.Vector3();
    const direction = new THREE.Vector3();
    this.getMuzzle(position, direction);
    if(this.sensingRadius > 0 && position.distanceTo(sphere.center) - sphere.radius > this.sensingRadius){
      return false;
    }
    return new THREE.Ray(position, direction).intersectsSphere(sphere);
  }

  /** Fire one bullet if the bank is ready. Returns the spawned bullet. */
  fire(): ModuleMGGunBullet | undefined {
    if(!this.proto_bullet || this.fireTimer > 0){
      return undefined;
    }

    this.fireTimer = this.proto_bullet.rate_of_fire || 0;

    if(this.fireSound){
      GameState.guiAudioEmitter?.playSoundFireAndForget(this.fireSound);
    }

    if(this.model instanceof OdysseyModel3D){
      this.model.playAnimation('fire', false);
    }

    const bullet = new ModuleMGGunBullet( this.bulletTemplate, this );
    bullet.copyStats(this.proto_bullet);
    this.getMuzzle(bullet.position, bullet.direction, bullet.quaternion);
    this.bullets.push(bullet);
    bullet.loadModel().then((model) => {
      if(model && bullet.life < bullet.lifespan){
        GameState.group?.placeables?.add(model);
      }
    }).catch((e) => console.warn(`ModuleMGGunBank.fire: bullet model [${bullet.model_name}] failed to load`, e));

    (this.owner as any)?.onFire?.(bullet);
    return bullet;
  }

  clearBullets(){
    for(const bullet of this.bullets){
      bullet.destroyBullet();
    }
    this.bullets = [];
  }

  async load(){
    this.initProperties();
    await this.loadModel();
  }

  async loadModel(){
    const resref = (this.gunModel || '').replace(/\0[\s\S]*$/g,'').toLowerCase();
    if(!resref){ return; }
    try{
      const mdl = await MDLLoader.loader.load(resref);
      const model = await OdysseyModel3D.FromMDL(mdl, {
        context: this.context,
        castShadow: true,
        receiveShadow: true
      });
      this.model = model;
      this.bullet_hook = this.model.getObjectByName('bullethook0');
    }catch(e){
      console.warn(`ModuleMGGunBank.loadModel: gun model [${resref}] failed to load`, e);
    }
  }

  initProperties(){
    this.bankID = 0;
    this.fireTimer = 0;
    this.fireSound = '';
    this.fire_sound = '';
    this.gunModel = '';
    this.horizSpread = 0;
    this.inaccuracy = 0;
    this.sensingRadius = 0;
    this.vertSpread = 0;
    this.bulletTemplate = undefined;
    this.proto_bullet = undefined;

    if(this.template.RootNode.hasField('BankID'))
      this.bankID = this.template.getFieldByLabel('BankID').getValue()

    if(this.template.RootNode.hasField('Fire_Sound'))
      this.fireSound = this.template.getFieldByLabel('Fire_Sound').getValue()

    this.fire_sound = this.fireSound;

    if(this.template.RootNode.hasField('Gun_Model'))
      this.gunModel = this.template.getFieldByLabel('Gun_Model').getValue()

    if(this.template.RootNode.hasField('Horiz_Spread'))
      this.horizSpread = this.template.getFieldByLabel('Horiz_Spread').getValue()

    if(this.template.RootNode.hasField('Inaccuracy'))
      this.inaccuracy = this.template.getFieldByLabel('Inaccuracy').getValue()

    if(this.template.RootNode.hasField('Sensing_Radius'))
      this.sensingRadius = this.template.getFieldByLabel('Sensing_Radius').getValue()

    if(this.template.RootNode.hasField('Vert_Spread'))
      this.vertSpread = this.template.getFieldByLabel('Vert_Spread').getValue()

    if(this.template.RootNode.hasField('Bullet')){
      const bulletStruct = this.template.RootNode.getFieldByLabel('Bullet').getChildStructs()[0];
      if(bulletStruct){
        this.bulletTemplate = GFFObject.FromStruct(bulletStruct);
        this.proto_bullet = new ModuleMGGunBullet(this.bulletTemplate, this);
        this.proto_bullet.initProperties();
      }
    }

    this.initialized = true;

  }

}
