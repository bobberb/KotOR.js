/**
 * Headless swoop/turret fixtures: synthetic ARE MiniGame structs, plain THREE
 * tracks (an Object3D with a `modelhook` child, like the track MDLs), fake
 * scripts. No game assets are used. Callers jest.mock the browser/engine
 * boundaries themselves (renderer, loaders, NWScript VM).
 */
import * as THREE from "three";
import { GFFStruct } from "@/resource/GFFStruct";
import { GFFField } from "@/resource/GFFField";
import { GFFDataType } from "@/enums/resource/GFFDataType";

export type Fields = Record<string, unknown>;

export function gffStruct(fields: Fields): GFFStruct {
  const struct = new GFFStruct(0);
  for (const [label, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      const list = new GFFField(GFFDataType.LIST, label);
      for (const child of value) list.addChildStruct(gffStruct(child as Fields));
      struct.addField(list);
    } else if (typeof value === "string") {
      struct.addField(new GFFField(GFFDataType.RESREF, label, value));
    } else if (value && typeof value === "object") {
      struct.addField(new GFFField(GFFDataType.VECTOR, label, value));
    } else {
      struct.addField(new GFFField(GFFDataType.FLOAT, label, value));
    }
  }
  return struct;
}

export function miniGameStruct(type: number, player: Fields, enemies: Fields[] = [], are: Fields = {}): GFFStruct {
  return gffStruct({
    Bump_Plane: 0, CameraViewAngle: 50, DOF: 0, DoBumping: 0, Far_Clip: 500,
    LateralAccel: 0, MovementPerSec: 0, Music: 0, Near_Clip: 0.5, Type: type, UseInertia: 0,
    ...are,
    Player: [player],
    Enemies: enemies,
  });
}

export function bulletBank(bullet: Fields, extra: Fields = {}): Fields {
  return {
    BankID: 0, Gun_Model: "", Fire_Sound: "", Sensing_Radius: 0, Horiz_Spread: 0, Vert_Spread: 0, Inaccuracy: 0,
    Bullet: [{ Bullet_Model: "", Collision_Sound: "", Target_Type: 1, ...bullet }],
    ...extra,
  };
}

/** A track model stand-in: objects ride its `modelhook` child, like the retail track MDLs. */
export function makeTrack(x = 0, y = 0, z = 0): THREE.Object3D {
  const track = new THREE.Object3D();
  const hook = new THREE.Object3D();
  hook.name = "modelhook";
  track.add(hook);
  track.position.set(x, y, z);
  track.updateMatrixWorld(true);
  return track;
}

export type FakeScript = { run: (caller: unknown, scriptVar?: number) => void; calls: number };

/** A stand-in NWScriptInstance whose body is a JS callback receiving OBJECT_SELF. */
export function fakeScript(body: (caller: any) => void = () => {}): FakeScript {
  const script: FakeScript = {
    calls: 0,
    run(caller: unknown) {
      script.calls++;
      body(caller);
    },
  };
  return script;
}
