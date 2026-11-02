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
  static pendingMessage: string | undefined;

  /**
   * Show the death menu (Load Game / Quit). Resolves false when the game-over GUI
   * could not be built (missing GUI resource); the load-game menu is opened
   * instead so the player is never left with a dead party and no way out.
   */
  static OpenDeathScreen(message?: string): Promise<boolean> {
    const partyDeath = GameState.module?.partyDeath;
    if(partyDeath){
      partyDeath.deathScreenRequested = true;
    }
    // undefined keeps the current text (a re-open); '' restores the GUI's own.
    if(message !== undefined){
      GameOver.pendingMessage = message;
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
      if(GameOver.pendingMessage !== undefined){
        menu.setMessage(GameOver.pendingMessage);
        GameOver.pendingMessage = undefined;
      }
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
    GameOver.creditsPending = false;
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
    // In progress from the call itself: the menu is built asynchronously, and a
    // script checking straight after StartCreditSequence must already see TRUE.
    GameOver.creditsPending = true;
    try{
      const menu = await GameState.MenuManager.GetMenuCredits();
      if(!GameOver.creditsPending){ return false; }
      if(!menu?.tGuiPanel){
        console.warn('GameOver.StartCreditSequence: credits GUI unavailable');
        return false;
      }
      menu.startSequence();
      return true;
    }finally{
      GameOver.creditsPending = false;
    }
  }

  static creditsPending: boolean = false;

  static IsCreditSequenceInProgress(): boolean {
    return GameOver.creditsPending || !!GameState.MenuManager.MenuCredits?.inProgress;
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
