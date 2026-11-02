import { GameMenu } from "@/gui";
import type { GUIListBox } from "@/gui";
import { GameState } from "@/GameState";

/**
 * MenuCredits class.
 *
 * The StartCreditSequence crawl. It scrolls LB_CREDITS and closes itself when
 * the sequence has run, so IsCreditSequenceInProgress always turns FALSE and an
 * ending script waiting on it carries on. Escape skips it.
 *
 * KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
 *
 * @file MenuCredits.ts
 * @author KobaltBlu <https://github.com/KobaltBlu>
 * @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
 */
export class MenuCredits extends GameMenu {

  static readonly SECONDS_PER_LINE = 1.5;
  static readonly MIN_DURATION = 15;
  static readonly MAX_DURATION = 300;

  LB_CREDITS: GUIListBox;

  inProgress: boolean = false;
  elapsed: number = 0;
  duration: number = MenuCredits.MIN_DURATION;

  constructor(){
    super();
    this.gui_resref = 'credits';
    this.background = '';
    this.voidFill = false;
  }

  async menuControlInitializer(skipInit: boolean = false) {
    await super.menuControlInitializer();
    if(skipInit) return;
    return new Promise<void>((resolve, reject) => {
      resolve();
    });
}

  /**
   * Credit lines from a `credits` 2DA (a `text` column, or a `strref` column
   * into dialog.tlk) when the game data provides one. Which resource the retail
   * credits read is not verified; without one the crawl runs empty for
   * MIN_DURATION and still ends.
   */
  static GetCreditLines(): string[] {
    const table = GameState.TwoDAManager?.datatables?.get('credits');
    const rows: any[] = table?.rows ? Object.values(table.rows) : [];
    const lines: string[] = [];
    for(const row of rows){
      const text = row?.text && row.text != '****' ? String(row.text) : undefined;
      const strref = parseInt(row?.strref);
      const line = text ?? (!isNaN(strref) ? GameState.TLKManager?.GetStringById(strref)?.Value : undefined);
      if(line !== undefined){ lines.push(line); }
    }
    return lines;
  }

  startSequence(lines: string[] = MenuCredits.GetCreditLines()){
    this.elapsed = 0;
    this.duration = Math.min(MenuCredits.MAX_DURATION, Math.max(MenuCredits.MIN_DURATION, lines.length * MenuCredits.SECONDS_PER_LINE));
    this.LB_CREDITS?.mutate?.((tx) => {
      tx.clear();
      for(const line of lines){ tx.add(line); }
    });
    if(this.LB_CREDITS){
      this.LB_CREDITS.scroll = 0;
    }
    this.inProgress = true;
    this.open();
  }

  update(delta: number = 0){
    super.update(delta);
    if(!this.inProgress){ return; }
    this.elapsed += delta;
    const list = this.LB_CREDITS;
    if(list && list.maxScroll > 0){
      list.scroll = list.maxScroll * Math.min(1, this.elapsed / this.duration);
      list.updateList();
    }
    if(this.elapsed >= this.duration){
      this.inProgress = false;
      // MenuManager.Update is iterating activeMenus right now; close after it.
      queueMicrotask(() => this.close());
    }
  }

  close(){
    this.inProgress = false;
    super.close();
  }

}
