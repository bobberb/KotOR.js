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

  static opening: Promise<boolean> | undefined;

  /**
   * Show the death menu (Load Game / Quit). Resolves false when the game-over GUI
   * could not be built (missing GUI resource); the load-game menu is opened
   * instead so the player is never left with a dead party and no way out.
   */
  static OpenDeathScreen(): Promise<boolean> {
    const partyDeath = GameState.module?.partyDeath;
    if(partyDeath){
      partyDeath.deathScreenRequested = true;
    }
    // The menu is built asynchronously the first time; ticks in between must not build it twice.
    if(!GameOver.opening){
      GameOver.opening = GameOver.openDeathScreen().finally(() => {
        GameOver.opening = undefined;
      });
    }
    return GameOver.opening;
  }

  private static async openDeathScreen(): Promise<boolean> {
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

  /**
   * True while the death menu, or the load menu reached from it, is on screen.
   */
  static IsDeathScreenUp(): boolean {
    const manager = GameState.MenuManager;
    return [manager.MenuGameOver, manager.MenuSaveLoad].some((menu) => !!menu && manager.activeMenus.indexOf(menu) >= 0);
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

  /**
   * Starts the credits. They end by themselves (MenuCredits.update), so a
   * script polling IsCreditSequenceInProgress always gets FALSE eventually.
   */
  static async StartCreditSequence(bTransparentBackground = false): Promise<boolean> {
    const menu = await GameState.MenuManager.GetMenuCredits();
    if(!menu?.tGuiPanel){
      console.warn('GameOver.StartCreditSequence: credits GUI unavailable');
      return false;
    }
    menu.startSequence();
    return true;
  }

  static IsCreditSequenceInProgress(): boolean {
    return !!GameState.MenuManager.MenuCredits?.inProgress;
  }

  /**
   * Deferred to the end of the frame: EndGame runs from scripts inside
   * Module.tick, and the rest of that frame (GameState.UpdateIngame) still
   * reads GameState.module.
   */
  static EndGame(bShowEndGameGui = false){
    queueMicrotask(() => GameOver.ReturnToMainMenu());
  }

}
