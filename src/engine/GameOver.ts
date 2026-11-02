import { GameState } from "@/GameState";
import { EngineState } from "@/enums/engine/EngineState";
import { MenuSaveLoadMode } from "@/enums/gui/MenuSaveLoadMode";

/**
 * GameOver class.
 *
 * End-of-game flows shared by the death GUI (PopUpDeathGUIPanel), the credits
 * (StartCreditSequence) and EndGame.
 *
 * KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
 *
 * @file GameOver.ts
 * @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
 */
export class GameOver {

  static creditsInProgress: boolean = false;

  /**
   * Show the death menu (Load Game / Quit). Returns false when the game-over GUI
   * could not be built (missing GUI resource); the load-game menu is opened
   * instead so the player is never left with a dead party and no way out.
   */
  static async OpenDeathScreen(): Promise<boolean> {
    const manager = GameState.MenuManager;
    const menu = await manager.GetMenuGameOver();
    if(menu?.tGuiPanel){
      if(manager.activeMenus.indexOf(menu) == -1){
        menu.open();
      }
      return true;
    }
    console.warn('GameOver.OpenDeathScreen: game over GUI unavailable, opening the load menu');
    GameOver.OpenLoadGame();
    return false;
  }

  static OpenLoadGame(){
    const manager = GameState.MenuManager;
    manager.MenuSaveLoad.mode = MenuSaveLoadMode.LOADGAME;
    manager.MenuSaveLoad.open();
  }

  /**
   * Same teardown as the in-game Options > Quit button.
   */
  static ReturnToMainMenu(){
    GameOver.creditsInProgress = false;
    GameState.UnloadModule();
    GameState.State = EngineState.RUNNING;

    if(GameState.module){
      GameState.module.dispose();
      GameState.module = undefined;
    }

    GameState.NWScript.Reload();
    GameState.controls.initKeys();
    GameState.MenuManager.MainMenu.Start();
  }

  static async StartCreditSequence(bTransparentBackground = false): Promise<boolean> {
    const menu = await GameState.MenuManager.GetMenuCredits();
    if(!menu?.tGuiPanel){
      console.warn('GameOver.StartCreditSequence: credits GUI unavailable');
      return false;
    }
    GameOver.creditsInProgress = true;
    menu.open();
    return true;
  }

  static IsCreditSequenceInProgress(): boolean {
    const menu = GameState.MenuManager.MenuCredits;
    return GameOver.creditsInProgress && !!menu && GameState.MenuManager.activeMenus.indexOf(menu) >= 0;
  }

  static EndGame(bShowEndGameGui = false){
    GameOver.ReturnToMainMenu();
  }

}
