import { GameState } from "@/GameState";
import { EngineState } from "@/enums/engine/EngineState";
import { MiniGameType } from "@/enums/engine/MiniGameType";

/** The parts of a KeyMapper Keymap the minigame processors read. */
export interface IMiniGameKeymap {
  keyboardInput?: { down?: boolean; pressed?: boolean };
  gamepadInput?: { down?: boolean; pressed?: boolean; value?: number; pressThreshold?: number };
}

export type MiniGameAction = 'up' | 'down' | 'left' | 'right' | 'shoot';

/** Turret aim rate in radians per second (unchanged from the original controls). */
export const TURRET_AIM_RATE = 1;

/**
 * Whether the input is held this frame. Uses the held state, never `pressed`: for
 * gamepads `pressed` is only the first frame plus a repeat pulse.
 */
export function inputHeld(keymap: IMiniGameKeymap): boolean {
  if(keymap?.keyboardInput?.down){ return true; }
  const pad = keymap?.gamepadInput;
  if(!pad){ return false; }
  if(typeof pad.down === 'boolean'){ return pad.down; }
  if(typeof pad.value === 'number'){ return Math.abs(pad.value) >= (pad.pressThreshold ?? 0.5); }
  return false;
}

/** Minigame key handling for EngineMode.MINIGAME (registered by IngameControls). */
export function processMiniGameAction(action: MiniGameAction, keymap: IMiniGameKeymap, delta: number = 0){
  if(GameState.State != EngineState.RUNNING){ return; }
  const miniGame = GameState.module?.area?.miniGame;
  const player = miniGame?.player;
  if(!player){ return; }
  const held = inputHeld(keymap);

  if(miniGame.type == MiniGameType.SWOOPRACE){
    switch(action){
      case 'up': if(held) player.jump(); break;
      case 'left': if(held) player.steer(-1); break;
      case 'right': if(held) player.steer(1); break;
      // The shift latch needs to see releases too.
      case 'shoot': player.setShiftInput(held); break;
    }
    return;
  }

  if(miniGame.type == MiniGameType.TURRET){
    if(!held){ return; }
    switch(action){
      case 'up': player.rotate('x', TURRET_AIM_RATE * delta); break;
      case 'down': player.rotate('x', -TURRET_AIM_RATE * delta); break;
      case 'left': player.rotate('z', TURRET_AIM_RATE * delta); break;
      case 'right': player.rotate('z', -TURRET_AIM_RATE * delta); break;
      // Held fire; the gun banks' time between shots sets the rate.
      case 'shoot': player.fire(); break;
    }
  }
}
