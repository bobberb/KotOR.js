import type { GUIButton, GUILabel } from "@/gui";
import { MenuGameOver as K1_MenuGameOver } from "@/game/kotor/menu/MenuGameOver";

/**
 * MenuGameOver class.
 *
 * KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
 *
 * @file MenuGameOver.ts
 * @author KobaltBlu <https://github.com/KobaltBlu>
 * @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
 */
export class MenuGameOver extends K1_MenuGameOver {

  declare BTN_LASTSAVE: GUIButton;
  declare BTN_LOADGAME: GUIButton;
  declare BTN_QUIT: GUIButton;
  declare LBL_MESSAGE: GUILabel;

  constructor(){
    super();
    this.gui_resref = 'gameover_p';
    this.background = '';
    this.voidFill = false;
  }

}
