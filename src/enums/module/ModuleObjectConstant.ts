/**
 * ModuleObjectConstant enum.
 * 
 * KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
 * 
 * @file ModuleObjectConstant.ts
 * @author KobaltBlu <https://github.com/KobaltBlu>
 * @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
 * @enum
 */
export enum ModuleObjectConstant {
  OBJECT_INVALID = 0x7f000000,
  /**
   * Object id of the module (GetModule(), OBJECT_SELF in Mod_* scripts) so
   * delayed commands and saved script stacks can refer to it. Engine-local:
   * sits between OBJECT_INVALID and the player ids that count down from
   * PLAYER_ID; the retail value is not verified.
   */
  MODULE_ID = 0x7f000001,
  PLAYER_ID = 0x7fffffff,
}