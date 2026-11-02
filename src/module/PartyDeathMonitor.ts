import { GameState } from "@/GameState";
import { EngineMode } from "@/enums/engine/EngineMode";
import { GameOver } from "@/engine/GameOver";
import type { ModuleCreature } from "@/module/ModuleCreature";

/**
 * PartyDeathMonitor class.
 *
 * KotOR party death rules, evaluated once per module tick:
 *  - the leader goes down while a companion still stands: control passes to
 *    the first living member;
 *  - every member is down: Mod_OnPlrDying then Mod_OnPlrDeath run once
 *    (re-armed only after someone is back up). With no OnPlrDeath script the
 *    engine opens the death screen itself;
 *  - members who went down while someone survived get back up at 1 HP once no
 *    living member is in combat and they have been down REVIVE_DELAY seconds.
 *
 * "Down" is ModuleCreature.isDead() (HP <= 0 without Min1HP); KotOR has no
 * separate dying band.
 *
 * KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
 *
 * @file PartyDeathMonitor.ts
 * @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
 */
export class PartyDeathMonitor {

  /** Lets the death animation finish before a companion gets back up. */
  static readonly REVIVE_DELAY = 3;

  gameOver: boolean = false;
  downTime: Map<ModuleCreature, number> = new Map();

  reset(){
    this.gameOver = false;
    this.downTime.clear();
  }

  /** Members without hit points yet (template not loaded) are not judged. */
  static isParticipant(creature: ModuleCreature): boolean {
    return !!creature && typeof creature.isDead === 'function' && creature.getMaxHP() > 0;
  }

  static isDown(creature: ModuleCreature): boolean {
    return creature.isDead();
  }

  static isInCombat(creature: ModuleCreature): boolean {
    return !!creature.combatData?.combatState;
  }

  update(delta = 0){
    if(GameState.Mode == EngineMode.MINIGAME){ return; }
    const partyManager = GameState.PartyManager;
    const party = (partyManager?.party || []).filter(PartyDeathMonitor.isParticipant);
    if(!party.length){ return; }

    for(const creature of this.downTime.keys()){
      if(party.indexOf(creature) == -1){ this.downTime.delete(creature); }
    }

    const living = party.filter((creature) => !PartyDeathMonitor.isDown(creature));
    if(!living.length){
      this.onPartyDefeated(party[0]);
      return;
    }
    this.gameOver = false;

    const leader = partyManager.party[0];
    if(leader && PartyDeathMonitor.isDown(leader)){
      partyManager.SwitchLeaderAtIndex(partyManager.party.indexOf(living[0]));
    }

    this.updateRevive(delta, party, living);
  }

  onPartyDefeated(leader: ModuleCreature){
    if(this.gameOver){ return; }
    this.gameOver = true;
    this.downTime.clear();

    const module = GameState.module;
    module.onPlayerDying(leader);

    // A dying script may have revived someone (SetMinOneHP, a heal).
    const party = (GameState.PartyManager.party || []).filter(PartyDeathMonitor.isParticipant);
    if(party.some((creature) => !PartyDeathMonitor.isDown(creature))){
      this.gameOver = false;
      return;
    }

    if(!module.onPlayerDeath(leader)){
      void GameOver.OpenDeathScreen();
    }
  }

  updateRevive(delta: number, party: ModuleCreature[], living: ModuleCreature[]){
    const inCombat = living.some(PartyDeathMonitor.isInCombat);
    for(const creature of party){
      if(!PartyDeathMonitor.isDown(creature)){
        this.downTime.delete(creature);
        continue;
      }
      const downFor = (this.downTime.get(creature) || 0) + delta;
      this.downTime.set(creature, downFor);
      if(!inCombat && downFor >= PartyDeathMonitor.REVIVE_DELAY){
        PartyDeathMonitor.revive(creature);
        this.downTime.delete(creature);
      }
    }
  }

  static revive(creature: ModuleCreature){
    // addHP with ignoreMaxHitPoints is linear in currentHitPoints for every
    // subrace, unlike setHP().
    creature.addHP(1 - creature.getHP(), true);
  }

}
