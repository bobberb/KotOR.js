import { GameMenu } from "@/gui";
import type { GUIButton, GUILabel } from "@/gui";
import { GameOver } from "@/engine/GameOver";

/**
 * MenuGameOver class.
 *
 * Death screen opened by PopUpDeathGUIPanel (or by the engine when the whole
 * party is down and the module has no OnPlayerDeath script).
 * Load Game opens the load menu; Quit returns to the main menu.
 *
 * KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
 *
 * @file MenuGameOver.ts
 * @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
 */
export class MenuGameOver extends GameMenu {

  declare BTN_LASTSAVE: GUIButton;
  declare BTN_LOADGAME: GUIButton;
  declare BTN_QUIT: GUIButton;
  declare LBL_MESSAGE: GUILabel;

  constructor(){
    super();
    // Unverified against retail K1 data; GameOver.OpenDeathScreen falls back to
    // the load menu if this GUI does not exist.
    this.gui_resref = 'gameover';
    this.background = '';
    this.voidFill = true;
    // Escape would drop the player back into a world where the whole party is dead.
    this.userCanClose = false;
  }

  async menuControlInitializer(skipInit: boolean = false) {
    await super.menuControlInitializer(true);
    if(skipInit) return;
    this.bindButtons();
  }

  bindButtons(){
    // TSL's gameover_p has a "load last save" button; it opens the same load
    // menu (the last save is the first entry there).
    for(const button of [this.BTN_LOADGAME, this.BTN_LASTSAVE]){
      button?.addEventListener('click', (e: any) => {
        e?.stopPropagation?.();
        this.loadGame();
      });
    }
    this.BTN_QUIT?.addEventListener('click', (e: any) => {
      e?.stopPropagation?.();
      this.quit();
    });
    this.selectedControl = this.BTN_LOADGAME || this.BTN_LASTSAVE || this.BTN_QUIT;
  }

  defaultMessage: string | undefined;

  /**
   * The reason line (PopUpDeathGUIPanel's help string). An empty message
   * restores the GUI's own text, so one death's reason never leaks into the next.
   */
  setMessage(message = ''){
    if(!this.LBL_MESSAGE){ return; }
    if(this.defaultMessage === undefined){
      this.defaultMessage = this.LBL_MESSAGE.getText?.() ?? '';
    }
    this.LBL_MESSAGE.setText(message || this.defaultMessage);
  }

  loadGame(){
    GameOver.OpenLoadGame();
  }

  quit(){
    GameOver.ReturnToMainMenu();
  }

}
