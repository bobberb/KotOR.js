import { ModuleObject } from "@/module/ModuleObject";
import { GFFObject } from "@/resource/GFFObject";
import * as THREE from "three";
import { GameState } from "@/GameState";
import { OdysseyModel3D } from "@/three/odyssey";
import { ModuleObjectType } from "@/enums/module/ModuleObjectType";
import { MDLLoader } from "@/loaders";
import type { ModuleMGGunBank } from "@/module/ModuleMGGunBank";
import type { IMiniGameEventContext, ModuleMiniGame } from "@/module/ModuleMiniGame";

/** Anything a bullet can hit: it exposes a world-space collision sphere and a hit handler. */
interface IBulletTarget extends ModuleObject {
  alive?: boolean;
  trigger?: boolean;
  getWorldSphere(): THREE.Sphere;
  getEventModelName?(): string;
  onHitBullet(bullet: ModuleMGGunBullet): void;
}

/**
* ModuleMGGunBullet class.
*
* Class representing a bullet that was spawned from gun banks found in minigame modules.
*
* KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
*
* @file ModuleMGGunBullet.ts
* @author KobaltBlu <https://github.com/KobaltBlu>
* @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
* @memberof KotOR
*/
export class ModuleMGGunBullet extends ModuleObject {
  owner: ModuleMGGunBank;
  life: number;
  direction: THREE.Vector3;
  velocity: THREE.Vector3;
  lifespan: number = 0;
  model_name: string = '';
  collision_sound: string = '';
  rate_of_fire: number = 0;
  target_type: number = 0;
  damage_amt: number = 0;

  directionLine: THREE.Line3 = new THREE.Line3();
  directionLinePoint: THREE.Vector3 = new THREE.Vector3();

  constructor( template: GFFObject, owner: ModuleMGGunBank ){
    super();
    this.objectType |= ModuleObjectType.ModuleMGGunBullet;
    this.template = template;
    this.owner = owner;

    this.life = 0;

    this.direction = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
  }

  getMiniGame(): ModuleMiniGame | undefined {
    return (this.owner?.owner as any)?.getMiniGame?.() ?? GameState.module?.area?.miniGame;
  }

  /** Player bullets hit live, non-trigger followers and obstacles; enemy bullets hit the player. */
  getTargets(): IBulletTarget[] {
    const miniGame = this.getMiniGame();
    if(!miniGame){ return []; }
    if(this.owner?.isPlayer){
      return [
        ...miniGame.enemies.filter((enemy) => enemy.alive && !enemy.trigger),
        ...miniGame.obstacles,
      ] as IBulletTarget[];
    }
    return miniGame.player?.alive ? [miniGame.player as IBulletTarget] : [];
  }

  /** Event values SWMG_GetLastBulletHit* report inside the target's OnHitBullet. */
  getHitContext(target: ModuleObject): Partial<IMiniGameEventContext> {
    return {
      bullet: this,
      bulletHitDamage: this.damage_amt,
      bulletHitTarget: this.target_type,
      bulletHitShooter: this.owner?.owner,
      bulletHitPart: (target as any)?.getEventModelName?.() ?? '',
    };
  }

  /** The target whose sphere this frame's path (directionLine) enters first, if any. */
  findFirstHit(): IBulletTarget | undefined {
    const start = this.directionLine.start;
    const length = this.directionLine.distance();
    const ray = new THREE.Ray(start.clone(), this.directionLine.delta(new THREE.Vector3()).normalize());
    const entry = new THREE.Vector3();
    let best: IBulletTarget | undefined;
    let bestDistance = Infinity;
    for(const target of this.getTargets()){
      const sphere = target.getWorldSphere();
      if(!(sphere.radius > 0)){ continue; }
      let distance: number;
      if(sphere.containsPoint(start)){
        distance = 0;
      }else if(length > 0 && ray.intersectSphere(sphere, entry)){
        distance = start.distanceTo(entry);
      }else{
        continue;
      }
      if(distance <= length && distance < bestDistance){
        best = target;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Advance one frame. Returns false once the bullet is spent (lifespan over or it hit something). */
  update(delta = 0){
    this.life += delta;

    if(this.life >= this.lifespan){
      this.destroyBullet();
      return false;
    }

    this.velocity.set(0, this.speed * delta, 0);
    this.velocity.applyQuaternion(this.quaternion);

    this.directionLine.start.copy(this.position);
    this.directionLine.end.copy(this.position).add(this.velocity);

    this.position.add( this.velocity );
    if(this.model){
      this.model.quaternion.copy(this.quaternion);
      this.model.position.copy(this.position);
    }

    // Swept test along this frame's path so fast bullets cannot tunnel through a target;
    // the bullet stops at the first sphere it enters along the path.
    const hit = this.findFirstHit();
    if(hit){
      this.life = Infinity;
      if(this.collision_sound){
        GameState.guiAudioEmitter?.playSoundFireAndForget(this.collision_sound);
      }
      hit.onHitBullet(this);
      this.destroyBullet();
      return false;
    }

    if(this.model instanceof OdysseyModel3D) this.model.update(delta);
    return true;
  }

  updatePaused(delta: number = 0){

  }

  destroyBullet(){
    this.life = Infinity;
    if(!this.model){ return; }
    this.model.parent?.remove(this.model);
    (this.model as any).dispose?.();
  }

  /** Copy the bank's (possibly script-modified) bullet stats. */
  copyStats(proto: ModuleMGGunBullet){
    this.model_name = proto.model_name;
    this.collision_sound = proto.collision_sound;
    this.damage_amt = proto.damage_amt;
    this.lifespan = proto.lifespan;
    this.rate_of_fire = proto.rate_of_fire;
    this.speed = proto.speed;
    this.target_type = proto.target_type;
  }

  async load(){
    this.initProperties();
    await this.loadModel();
  }

  async loadModel(): Promise<OdysseyModel3D | undefined> {
    const resref = (this.model_name || '').replace(/\0[\s\S]*$/g,'').toLowerCase();
    if(!resref){ return undefined; }
    const mdl = await MDLLoader.loader.load(resref);
    const model = await OdysseyModel3D.FromMDL(mdl, { context: this.context });
    if(this.life >= this.lifespan){
      (model as any)?.dispose?.();
      return undefined;
    }
    this.model = model;
    model.position.copy(this.position);
    model.quaternion.copy(this.quaternion);
    return model;
  }

  initProperties(){
    const root = this.template?.RootNode;
    const field = (label: string, fallback: any) => root?.hasField(label) ? root.getFieldByLabel(label).getValue() : fallback;
    this.model_name = field('Bullet_Model', '');
    this.collision_sound = field('Collision_Sound', '');
    this.damage_amt = field('Damage', 0);
    this.lifespan = field('Lifespan', 0);
    this.rate_of_fire = field('Rate_Of_Fire', 0);
    this.speed = field('Speed', 0);
    this.target_type = field('Target_Type', 0);

    //TSL speed needs to be increased
    if(this.speed < 1){
      this.speed *= 1000;
    }
  }

}
