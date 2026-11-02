import { GameState } from "@/GameState";
import { PazaakCards } from "@/enums/minigames/PazaakCards";
import { PazaakHandSlots } from "@/enums/minigames/PazaakHandSlots";
import { PazaakSideDeckSlots } from "@/enums/minigames/PazaakSideDeckSlots";
import { PazaakTableSlots } from "@/enums/minigames/PazaakTableSlots";
import { PazaakTurnMode } from "@/enums/minigames/PazaakTurnMode";
import { PazaakTurnState } from "@/enums/minigames/PazaakTurnState";
import { IPTPazaakCard } from "@/interface/minigames/IPTPazaakCard";
import { IPazaakTable } from "@/interface/minigames/IPazaakTable";
import { ModuleCreature } from "@/module/ModuleCreature";
import type { NWScriptInstance } from "@/nwscript/NWScriptInstance";
import { PazaakConfig as PazaakConfig_TSL } from "@/game/tsl/minigames/mg-pazaak-config";
import { PazaakConfig as PazaakConfig_KOTOR } from "@/game/kotor/minigames/mg-pazaak-config";
import { GameEngineType } from "@/enums/engine/GameEngineType";
import { IPazaakCard } from "@/interface/minigames/IPazaakCard";
import { ActionStatus } from "@/enums/actions/ActionStatus";
import {
  IPazaakAIContext, IPazaakSide, PazaakEndOfTurn, PazaakRoundResult,
  aiShouldStand, applyCardToTable, buildMainDeck, chooseAIMove, dealHand,
  decideRoundWinner, evaluateEndOfTurn, matchWinner, shuffle, sumTable, wagerPayout,
} from "@/engine/minigames/PazaakRules";

const MSG_CONFIRM_SIDE_DECK = 32322;
const MSG_YOU_WIN = 32334;
const MSG_TIED = 32338;
const MSG_YOU_LOSE = 32335;

/**
 * [Sound Effects]
 * - mgs_playside
 * - mgs_drawmain
 * - mgs_loseset
 * - mgs_losematch
 * - mgs_winmatch
 * - mgs_winset
 * - mgs_warnbust
 */

enum PazaakActionType {
  WAIT = 0,
  DRAW_CARD = 1,
  PLAY_HAND_CARD = 2,
  PLAY_GUI_SOUND = 3,
  BEGIN_TURN = 4,
  END_TURN = 5,
  BEGIN_ROUND = 6,
  END_ROUND = 7,
  END_GAME = 8,
  AI_DETERMINE_MOVE = 9,
  SHOW_MESSAGE = 10
}

enum PazaakActionPropertyType {
  STRING = 0,
  NUMBER = 1
}

interface IPazaakActionProperty {
  type: PazaakActionPropertyType;
  value: string | number;
}

interface IPazaakAction {
  type: PazaakActionType;
  tableIndex: number;
  properties: IPazaakActionProperty[];
}

interface IPazaakConfig {
  name: string;
  textures: {name: string, file: string}[];
  data: {
    rounds: number;
    mainDeckCards: IPazaakCard[];
    sideDeckCards: IPazaakCard[];
  }
}

export class PazaakManager {

  static Config: IPazaakConfig = PazaakConfig_TSL;
  static Wager: number = 100;
  static MinWager: number = 1;
  static MaxWager: number = 100;
  static EndScript: string = '';
  static EndScriptInstance: NWScriptInstance = undefined;
  static ShowTutorial: boolean = false;
  static Opponent: ModuleCreature = undefined;
  // static OpponentDeck: Map<PazaakSideDeckSlots, PazaakCards> = new Map<PazaakSideDeckSlots, PazaakCards>();
  static Cards: Map<PazaakCards, IPTPazaakCard> = new Map<PazaakCards, IPTPazaakCard>();
  // static SideDeck: Map<PazaakSideDeckSlots, PazaakCards> = new Map<PazaakSideDeckSlots, PazaakCards>();
  static Won: boolean = false;
  /** Credits moved to the player by the last finished match (+wager / -wager). */
  static LastPayout: number = 0;
  static LastRoundResult: PazaakRoundResult = PazaakRoundResult.TIE;
  /** RNG for the main deck shuffle and hand deal; swappable for seeded play. */
  static Random: () => number = Math.random;
  /** Shared main deck for the current round; cards are popped off the end. */
  static MainDeck: number[] = [];

  static TotalSideDeckCards: number = 0;
  static TotalMainDeckCards: number = 0;
  static WaitTimer: number = 0;
  static TargetPoints: number = 20;

  static PlayerSideDeck: Map<PazaakSideDeckSlots, PazaakCards> = new Map<PazaakSideDeckSlots, PazaakCards>();
  static OpponentSideDeck: Map<PazaakSideDeckSlots, PazaakCards> = new Map<PazaakSideDeckSlots, PazaakCards>();

  static TurnState: PazaakTurnState = PazaakTurnState.INVALID;

  static Tables: IPazaakTable[] = [
    {
      points: 0,
      winCount: 0,
      stand: false,
      turnState: PazaakTurnState.INVALID,
      cardArea: new Map<PazaakTableSlots, IPazaakCard>(),
      sideDeck: new Map<PazaakSideDeckSlots, PazaakCards>(),
      handCards: new Map<PazaakHandSlots, PazaakCards>(),
      handCardPlayed: false,
      flipCards: new Map<PazaakHandSlots, boolean>(),
      swapValueCards: new Map<PazaakHandSlots, boolean>()
    },
    {
      points: 0,
      winCount: 0,
      stand: false,
      turnState: PazaakTurnState.INVALID,
      cardArea: new Map<PazaakTableSlots, IPazaakCard>(),
      sideDeck: new Map<PazaakSideDeckSlots, PazaakCards>(),
      handCards: new Map<PazaakHandSlots, PazaakCards>(),
      handCardPlayed: false,
      flipCards: new Map<PazaakHandSlots, boolean>(),
      swapValueCards: new Map<PazaakHandSlots, boolean>()
    }
  ];

  static TurnMode: PazaakTurnMode = PazaakTurnMode.PLAYER;
  static Actions: IPazaakAction[] = [];
  static TargetWins: number = 3;

  static {
    PazaakManager.Initialize();
  }

  /**
   * Initialize the Pazaak manager
   */
  static Initialize(){
    console.log(`PazaakManager: Initializing`);
    /**
     * Pazaak Cards
     * - index 0-4: 2 cards
     * - index 5-17: 0 cards
     * - index 18: unknown, always 0
     */
    for(let i = 0; i < PazaakCards.TSL_MAX_CARDS; i++){
      this.Cards.set(i, {
        card: i,
        count: (i < 5) ? 2 : 0
      });
    }

    /**
     * Pazaak Side Deck
     * - index 0-9: unset equals INVALID card (-1)
     * - the value of the card is the index of the card in the PazaakCards enum
     */
    for(let i = 0; i < PazaakSideDeckSlots.MAX_SLOTS; i++){
      this.Tables[0].sideDeck.set(i, PazaakCards.INVALID);
    }

    /**
     * Pazaak Player Side Deck
     */
    for(let i = 0; i < PazaakSideDeckSlots.MAX_SLOTS; i++){
      this.PlayerSideDeck.set(i, PazaakCards.INVALID);
    }

    this.Won = false;
    this.Actions = [];
  }

  static StartGame(){
    /**
     * Set the config based on the game engine
     */
    if(GameState.GameKey == GameEngineType.KOTOR){
      PazaakManager.Config = PazaakConfig_KOTOR;
    }else{
      PazaakManager.Config = PazaakConfig_TSL;
    }
    this.TotalMainDeckCards = PazaakManager.Config.data.mainDeckCards.length;
    this.TotalSideDeckCards = PazaakManager.Config.data.sideDeckCards.length;
    this.Won = false;
    this.TurnMode = PazaakTurnMode.PLAYER;
    for(let j = 0; j < 2; j++){
      this.Tables[j].points = 0;
      this.Tables[j].winCount = 0;
      this.Tables[j].stand = false;
      /**
       * Pazaak Card Area
       * - A pazaak table can have up to 9 cards on the table
       */
      for(let i = 0; i < PazaakTableSlots.MAX_SLOTS; i++){
        this.Tables[j].cardArea.set(i, undefined);
      }

      /**
       * Pazaak Side Deck
       * - index 0-9: unset equals INVALID card (-1)
       * - the value of the card is the index of the card in the PazaakCards enum
       */
      for(let i = 0; i < PazaakSideDeckSlots.MAX_SLOTS; i++){
        this.Tables[j].sideDeck.set(i, PazaakCards.INVALID);
      }
    }

    this.Actions = [];
    GameState.MenuManager.MenuPazaakSetup.open();
  }

  /**
   * Set the opponent
   * @param creature - The creature to set
   */
  static SetOpponent(creature: ModuleCreature){
    this.Opponent = creature;
  }

  /**
   * Set the end script
   * @param script - The script to set
   */
  static SetEndScript(script: string){
    this.EndScript = script;
    try{
      this.EndScriptInstance = GameState.NWScript.Load(this.EndScript, true);
    }catch(e){
      console.error(`PazaakManager: Failed to load end script ${this.EndScript}: ${e}`);
    }
  }

  /**
   * Set the opponent's deck
   * @param deckIndex - The index of the deck to set
   */
  static SetOpponentDeck(deckIndex: number){
    const deckConfig = GameState.SWRuleSet.pazaakDecks[deckIndex] ||
      GameState.SWRuleSet.pazaakDecks[0];
    const deck = new Map<PazaakSideDeckSlots, PazaakCards>();
    for(let i = 0; i < PazaakSideDeckSlots.MAX_SLOTS; i++){
      const card = deckConfig.cards[i];
      if(card == PazaakCards.INVALID){
        console.error(`PazaakManager: Invalid card modifier ${deckConfig.cards[i]} for deck ${deckIndex}`);
      }
      deck.set(i, card != PazaakCards.INVALID ? card : PazaakCards.PLUS_1);
    }
    this.OpponentSideDeck = deck;
  }

  /**
   * Add a card to the main deck
   * @param cardIndex - The index of the card to add
   * @param count - The number of cards to add
   * @returns true if the card was added, false otherwise
   */
  static AddCard(cardIndex: PazaakCards, count: number = 1){
    if(cardIndex <= PazaakCards.INVALID || cardIndex >= this.GetMaxCards()){
      return false;
    }

    const card = this.Cards.get(cardIndex);
    card.count += count;
    return true;
  }

  /**
   * Remove a card from the main deck
   * @param cardIndex - The index of the card to remove
   * @param count - The number of cards to remove
   * @returns true if the card was removed, false otherwise
   */
  static RemoveCard(cardIndex: PazaakCards, count: number = 1){
    if(cardIndex <= PazaakCards.INVALID || cardIndex >= this.GetMaxCards()){
      return false;
    }

    const card = this.Cards.get(cardIndex);
    card.count -= count;
    //If the card count is less than 0, set it to 0
    if(card.count <= 0){
      card.count = 0;
      return false;
    }
    return true;
  }

  /**
   * Move a card to the side deck
   * @param card - The card to move
   * @param sideDeckIndex - The index of the side deck card to move
   */
  static MoveCardToSideDeck(card: PazaakCards, sideDeckIndex: number){
    const currentSDCard = this.PlayerSideDeck.get(sideDeckIndex);
    //If the side deck card is valid, add it to the main deck
    if(currentSDCard != PazaakCards.INVALID && currentSDCard < this.GetMaxCards()){
      this.AddCard(currentSDCard, 1);
    }
    //Set the side deck card to the new card
    this.PlayerSideDeck.set(sideDeckIndex, card);
    this.RemoveCard(card, 1);
  }

  /**
   * Move a side deck card to the main deck
   * @param sideDeckIndex - The index of the side deck card to move
   */
  static MoveSideDeckCardToMainDeck(sideDeckIndex: number){
    const card = this.PlayerSideDeck.get(sideDeckIndex);
    //If the side deck card is valid, add it to the main deck
    if(card != PazaakCards.INVALID && card < this.GetMaxCards()){
      this.AddCard(card, 1);
    }
    //Set the side deck card to an invalid value to clear the slot
    this.PlayerSideDeck.set(sideDeckIndex, PazaakCards.INVALID);
  }

  /**
   * Increase the wager
   * @param amount - The amount to increase the wager by
   */
  static IncreaseWager(amount: number = 1){
    this.Wager += amount;
    if(this.Wager > this.MaxWager){
      this.Wager = this.MaxWager;
    }
  }

  /**
   * Decrease the wager
   * @param amount - The amount to decrease the wager by
   */
  static DecreaseWager(amount: number = 1){
    this.Wager -= amount;
    if(this.Wager < this.MinWager){
      this.Wager = this.MinWager;
    }
  }

  /**
   * Cancel the Pazaak game from the wager/setup screen.
   */
  static CancelPazaak(){
    if(GameState.MenuManager?.MenuPazaakWager?.bVisible){
      GameState.MenuManager.MenuPazaakWager.close();
    }
    if(GameState.MenuManager?.MenuPazaakSetup?.bVisible){
      GameState.MenuManager.MenuPazaakSetup.close();
    }
  }

  static ProcessActionQueue(delta: number){
    if(this.Actions.length == 0){
      return;
    }

    const action = this.Actions[0];
    let actionStatus: ActionStatus = ActionStatus.IN_PROGRESS;
    /**
     * Wait for a specified amount of time
     */
    if(action.type == PazaakActionType.WAIT){
      let time = (action.properties[1].value as number) || 0;
      time += delta;
      action.properties[1].value = time;
      if(time >= (action.properties[0].value as number)){
        actionStatus = ActionStatus.COMPLETE;
      }
    }
    /**
     * Play a GUI sound
     */
    else if(action.type == PazaakActionType.PLAY_GUI_SOUND){
      GameState.guiAudioEmitter?.playSoundFireAndForget(this.GetActionPropertyAsString(0, 0));
      actionStatus = ActionStatus.COMPLETE;
    }
    /**
     * Begin the round
     */
    else if(action.type == PazaakActionType.BEGIN_ROUND){
      console.log(`PazaakManager: Begin round... Player starts first.`);
      this.TurnMode = PazaakTurnMode.PLAYER;
      for(let i = 0; i < this.Tables.length; i++){
        this.Tables[i].points = 0;
        this.Tables[i].stand = false;
        this.Tables[i].handCardPlayed = false;
        for(let j = 0; j < PazaakTableSlots.MAX_SLOTS; j++){
          this.Tables[i].cardArea.set(j, undefined);
        }
      }
      this.ResetMainDeck();
      //Begin the player's turn
      this.AddActionFront(this.TurnMode, PazaakActionType.BEGIN_TURN, [PazaakTurnMode.PLAYER]);
      actionStatus = ActionStatus.COMPLETE;
    }
    /**
     * Begin the turn
     */
    else if(action.type == PazaakActionType.BEGIN_TURN){
      const tableIndex = this.GetActionPropertyAsNumber(0, 0);
      console.log(`PazaakManager: Begin turn ${tableIndex == 0 ? `Player` : `Opponent`}`);
      const table = this.Tables[tableIndex];
      table.handCardPlayed = false;
      if(table.stand){
        this.AddActionFront(tableIndex, PazaakActionType.END_TURN, [tableIndex, 1]);
      }
      /**
       * Draw a card from the main deck
       */
      else{
        this.AddActionFront(tableIndex, PazaakActionType.DRAW_CARD, [tableIndex]);
        this.AddActionFront(tableIndex, PazaakActionType.WAIT, [0.5, 0]);
        this.AddActionFront(tableIndex, PazaakActionType.PLAY_GUI_SOUND, ['mgs_startturn']);
      }
      actionStatus = ActionStatus.COMPLETE;
    }
    /**
     * End the turn
     * Bust, nine-card fill and stand are only decided here (never right after
     * the draw) so a hand card played after the draw can still rescue a bust.
     */
    else if(action.type == PazaakActionType.END_TURN){
      const tableIndex = this.GetActionPropertyAsNumber(0, 0);
      const bStanding = this.GetActionPropertyAsNumber(0, 1) == 1;
      const table = this.Tables[tableIndex];
      const outcome = evaluateEndOfTurn(table.points, this.GetTableCardCount(tableIndex), bStanding, this.TargetPoints);
      table.stand = bStanding || outcome == PazaakEndOfTurn.STAND;
      console.log(`PazaakManager: End turn ${tableIndex == 0 ? 'Player' : 'Opponent'} [${table.stand ? 'standing' : 'not standing'}] outcome ${PazaakEndOfTurn[outcome]}`);

      this.TurnState = table.stand ? PazaakTurnState.STAND : PazaakTurnState.END_TURN;

      const bAllStand = this.Tables[PazaakTurnMode.PLAYER].stand && this.Tables[PazaakTurnMode.OPPONENT].stand;
      if(outcome == PazaakEndOfTurn.BUST || outcome == PazaakEndOfTurn.FILLED_TABLE || bAllStand){
        this.AddAction(this.TurnMode, PazaakActionType.END_ROUND);
      }else if(this.TurnMode == PazaakTurnMode.PLAYER){
        this.TurnMode = PazaakTurnMode.OPPONENT;
        this.AddAction(this.TurnMode, PazaakActionType.BEGIN_TURN, [PazaakTurnMode.OPPONENT]);
      }else{
        this.TurnMode = PazaakTurnMode.PLAYER;
        this.AddAction(this.TurnMode, PazaakActionType.BEGIN_TURN, [PazaakTurnMode.PLAYER]);
      }
      actionStatus = ActionStatus.COMPLETE;
    }
    /**
     * End the round
     * queue up the next round or end the game
     */
    else if(action.type == PazaakActionType.END_ROUND){
      const result = decideRoundWinner(
        this.GetTableSide(PazaakTurnMode.PLAYER),
        this.GetTableSide(PazaakTurnMode.OPPONENT),
        this.TargetPoints
      );
      this.LastRoundResult = result;
      console.log(`PazaakManager: End round ${this.Tables[0].points} - ${this.Tables[1].points} result ${PazaakRoundResult[result]}`);

      if(result == PazaakRoundResult.TIE){
        this.AddAction(this.TurnMode, PazaakActionType.PLAY_GUI_SOUND, ['mgs_warnbust']);
        this.AddAction(this.TurnMode, PazaakActionType.SHOW_MESSAGE, [MSG_TIED]);
      }else if(result == PazaakRoundResult.PLAYER){
        this.AddAction(this.TurnMode, PazaakActionType.PLAY_GUI_SOUND, ['mgs_winset']);
        this.AddAction(this.TurnMode, PazaakActionType.SHOW_MESSAGE, [MSG_YOU_WIN]);
        this.Tables[PazaakTurnMode.PLAYER].winCount++;
      }else{
        this.AddAction(this.TurnMode, PazaakActionType.PLAY_GUI_SOUND, ['mgs_loseset']);
        this.AddAction(this.TurnMode, PazaakActionType.SHOW_MESSAGE, [MSG_YOU_LOSE]);
        this.Tables[PazaakTurnMode.OPPONENT].winCount++;
      }

      this.AddAction(this.TurnMode, PazaakActionType.WAIT, [1, 0]);

      const winner = matchWinner(this.Tables.map((t) => t.winCount), this.TargetWins);
      if(winner != -1){
        this.AddAction(this.TurnMode, PazaakActionType.END_GAME, [winner]);
      }else{
        //The player always starts the next round
        this.TurnMode = PazaakTurnMode.PLAYER;
        this.AddAction(this.TurnMode, PazaakActionType.BEGIN_ROUND, [PazaakTurnMode.PLAYER]);
      }
      actionStatus = ActionStatus.COMPLETE;
    }
    else if(action.type == PazaakActionType.END_GAME){
      const winner = this.GetActionPropertyAsNumber(0, 0);
      this.Won = winner == PazaakTurnMode.PLAYER;
      const winnings = wagerPayout(this.Won, this.Wager);
      this.LastPayout = winnings;
      if(GameState.PartyManager?.Player && winnings != 0){
        GameState.PartyManager.Player.addGold(winnings);
      }
      console.log(`PazaakManager: End game ${winner == PazaakTurnMode.PLAYER ? 'Player' : 'Opponent'} wins! | ${winnings} gold`);
      GameState.MenuManager?.MenuPazaakGame?.close();
      if(this.EndScriptInstance){
        this.EndScriptInstance.run(this.Opponent);
      }
      actionStatus = ActionStatus.COMPLETE;
    }
    /**
     * Draw a card from the main deck onto the table
     */
    else if(action.type == PazaakActionType.DRAW_CARD){
      this.TurnState = PazaakTurnState.DRAW_CARD;
      const tableIndex = this.GetActionPropertyAsNumber(0, 0);
      const table = this.Tables[tableIndex];
      console.log(`PazaakManager: Draw card ${tableIndex == 0 ? 'Player' : 'Opponent'}`);

      const slot = this.GetFreeTableSlot(tableIndex);
      if(slot == -1){
        this.AddActionFront(tableIndex, PazaakActionType.END_TURN, [tableIndex, 0]);
      }else{
        const value = this.DrawMainDeckValue();
        const card: IPazaakCard = { ...this.Config.data.mainDeckCards[value - 1], flipped: false, value: value };
        table.cardArea.set(slot, card);
        this.RecalculatePoints(tableIndex);

        if(table.points == this.TargetPoints){
          this.AddActionFront(tableIndex, PazaakActionType.END_TURN, [tableIndex, 1]);
        }else if(this.GetTableCardCount(tableIndex) >= PazaakTableSlots.MAX_SLOTS){
          // No room for a hand card; END_TURN resolves bust or the nine-card win.
          this.AddActionFront(tableIndex, PazaakActionType.END_TURN, [tableIndex, 0]);
        }else{
          if(tableIndex == PazaakTurnMode.OPPONENT){
            this.AddActionFront(tableIndex, PazaakActionType.AI_DETERMINE_MOVE, [tableIndex]);
          }else if(table.points > this.TargetPoints && !this.HasPlayableHandCard(tableIndex)){
            this.AddActionFront(tableIndex, PazaakActionType.END_TURN, [tableIndex, 0]);
          }
          this.AddActionFront(tableIndex, PazaakActionType.WAIT, [1, 0]);
          this.AddActionFront(tableIndex, PazaakActionType.PLAY_GUI_SOUND, ['mgs_drawmain']);
          if(table.points > this.TargetPoints){
            this.AddActionFront(tableIndex, PazaakActionType.PLAY_GUI_SOUND, ['mgs_warnbust']);
          }
        }
      }
      actionStatus = ActionStatus.COMPLETE;
    }
    /**
     * Play a hand card
     */
    else if(action.type == PazaakActionType.PLAY_HAND_CARD){
      this.TurnState = PazaakTurnState.PLAY_HAND_CARD;
      const tableIndex = this.GetActionPropertyAsNumber(0, 0);
      const handIndex = this.GetActionPropertyAsNumber(0, 1);
      const flipped = this.GetActionPropertyAsNumber(0, 2) == 1;
      const swapped = this.GetActionPropertyAsNumber(0, 3) == 1;
      console.log(`PazaakManager: Play hand card ${tableIndex == 0 ? 'Player' : 'Opponent'} ${handIndex} ${flipped ? 'flipped' : 'not flipped'}`);

      const table = this.Tables[tableIndex];
      const cardIndex = table.handCards.get(handIndex);
      const slot = this.GetFreeTableSlot(tableIndex);
      const card: IPazaakCard = this.Config.data.sideDeckCards[cardIndex];
      // Complete (drop) invalid plays instead of returning early, which left
      // the action at the head of the queue forever.
      if(!card || slot == -1 || table.handCardPlayed){
        console.error(`PazaakManager: Invalid hand card play ${handIndex} (card ${cardIndex}, slot ${slot}, already played ${table.handCardPlayed})`);
      }else{
        const values = applyCardToTable(this.GetTableValues(tableIndex), card, { flipped, swapped });
        //Write back values first: flip cards rewrite cards already on the table
        let k = 0;
        for(let i = 0; i < PazaakTableSlots.MAX_SLOTS; i++){
          const tableCard = table.cardArea.get(i);
          if(tableCard) tableCard.value = values[k++];
        }
        //Clone so the shared config card is never mutated
        table.cardArea.set(slot, { ...card, flipped: card.reversible && flipped, value: values[values.length - 1] });
        table.handCards.set(handIndex, PazaakCards.INVALID);
        table.handCardPlayed = true;
        this.RecalculatePoints(tableIndex);

        this.AddActionFront(tableIndex, PazaakActionType.WAIT, [1, 0]);
        this.AddActionFront(tableIndex, PazaakActionType.PLAY_GUI_SOUND, ['mgs_playside']);

        if(tableIndex == PazaakTurnMode.OPPONENT){
          const stand = aiShouldStand(table.points, this.GetAIContext());
          this.AddAction(tableIndex, PazaakActionType.END_TURN, [tableIndex, stand ? 1 : 0]);
        }
      }

      actionStatus = ActionStatus.COMPLETE;
    }
    /**
     * AI determines a move
     */
    else if(action.type == PazaakActionType.AI_DETERMINE_MOVE){
      const tableIndex = this.GetActionPropertyAsNumber(0, 0);
      const aiTable = this.Tables[tableIndex];
      const hand: (IPazaakCard | undefined)[] = [];
      for(let i = 0; i < PazaakHandSlots.MAX_SLOTS; i++){
        const sdCardIndex = aiTable.handCards.get(i);
        hand.push(sdCardIndex == undefined || sdCardIndex == PazaakCards.INVALID ? undefined : this.Config.data.sideDeckCards[sdCardIndex]);
      }
      const move = chooseAIMove(this.GetTableValues(tableIndex), hand, this.GetAIContext());
      console.log(`PazaakManager: AI move hand ${move.handIndex} flipped ${move.flipped} swapped ${move.swapped} stand ${move.stand}`);
      if(move.handIndex > -1){
        this.AddActionFront(tableIndex, PazaakActionType.PLAY_HAND_CARD, [tableIndex, move.handIndex, move.flipped ? 1 : 0, move.swapped ? 1 : 0]);
      }else{
        this.AddActionFront(tableIndex, PazaakActionType.END_TURN, [tableIndex, move.stand ? 1 : 0]);
      }
      actionStatus = ActionStatus.COMPLETE;
    }
    /**
     * Show a message
     */
    else if(action.type == PazaakActionType.SHOW_MESSAGE){
      const tlkId = this.GetActionPropertyAsNumber(0, 0);
      GameState.MenuManager?.InGameConfirm?.fromStringRef(tlkId);
      actionStatus = ActionStatus.COMPLETE;
    }
    if(actionStatus == ActionStatus.COMPLETE){
      this.Actions.splice(this.Actions.indexOf(action), 1);
    }
  }

  static GetActionPropertyAsString(actionIndex: number, propertyIndex: number): string {
    return this.Actions[actionIndex].properties[propertyIndex]?.value as string;
  }

  static GetActionPropertyAsNumber(actionIndex: number, propertyIndex: number): number {
    return this.Actions[actionIndex].properties[propertyIndex]?.value as number;
  }

  //-----------------//
  // Table Helpers   //
  //-----------------//

  /**
   * Resolved values of the cards on a table, in play order.
   */
  static GetTableValues(tableIndex: number): number[] {
    const values: number[] = [];
    const table = this.Tables[tableIndex];
    for(let i = 0; i < PazaakTableSlots.MAX_SLOTS; i++){
      const card = table.cardArea.get(i);
      if(card) values.push(card.value ?? card.modifier[0]);
    }
    return values;
  }

  static GetTableCardCount(tableIndex: number): number {
    return this.GetTableValues(tableIndex).length;
  }

  static GetFreeTableSlot(tableIndex: number): number {
    const table = this.Tables[tableIndex];
    for(let i = 0; i < PazaakTableSlots.MAX_SLOTS; i++){
      if(!table.cardArea.get(i)) return i;
    }
    return -1;
  }

  static GetTableSide(tableIndex: number): IPazaakSide {
    const table = this.Tables[tableIndex];
    let tiebreaker = false;
    for(let i = 0; i < PazaakTableSlots.MAX_SLOTS; i++){
      if(table.cardArea.get(i)?.effect == 'tiebreaker') tiebreaker = true;
    }
    return { values: this.GetTableValues(tableIndex), tiebreaker };
  }

  static RecalculatePoints(tableIndex: number){
    this.Tables[tableIndex].points = sumTable(this.GetTableValues(tableIndex));
  }

  static HasPlayableHandCard(tableIndex: number): boolean {
    const table = this.Tables[tableIndex];
    if(table.handCardPlayed) return false;
    for(let i = 0; i < PazaakHandSlots.MAX_SLOTS; i++){
      const card = table.handCards.get(i);
      if(card != undefined && card != PazaakCards.INVALID) return true;
    }
    return false;
  }

  static GetAIContext(): IPazaakAIContext {
    return {
      playerPoints: this.Tables[PazaakTurnMode.PLAYER].points,
      playerStanding: this.Tables[PazaakTurnMode.PLAYER].stand,
      target: this.TargetPoints,
    };
  }

  /**
   * Shuffle a fresh shared main deck (4x 1-10). Called at the start of every round.
   */
  static ResetMainDeck(){
    this.MainDeck = shuffle(buildMainDeck(), this.Random);
  }

  static DrawMainDeckValue(): number {
    if(!this.MainDeck.length){
      this.ResetMainDeck();
    }
    return this.MainDeck.pop();
  }

  /**
   * Max card index the player's collection can hold for the running game.
   */
  static GetMaxCards(): number {
    return GameState.GameKey == GameEngineType.TSL ? PazaakCards.TSL_MAX_CARDS : PazaakCards.MAX_CARDS;
  }

  //-----------------//
  // Turn Management //
  //-----------------//

  static BuildAction(tableIndex: number, actionType: PazaakActionType, properties: any[] = []){
    const props: IPazaakActionProperty[] = [];
    for(let i = 0; i < properties.length; i++){
      let type = typeof properties[i] === 'string' ? PazaakActionPropertyType.STRING : PazaakActionPropertyType.NUMBER;
      props.push({
        type: type,
        value: properties[i]
      });
    }
    return {
      type: actionType,
      tableIndex: tableIndex,
      properties: props
    };
  }

  static AddAction(tableIndex: number, actionType: PazaakActionType, properties: any[] = []){
    const action = this.BuildAction(tableIndex, actionType, properties);
    this.Actions.push(action);
  }

  static AddActionFront(tableIndex: number, actionType: PazaakActionType, properties: any[] = []){
    const action = this.BuildAction(tableIndex, actionType, properties);
    this.Actions.unshift(action);
  }

  static ClearActions(){
    this.Actions = [];
  }

  /**
   * Begin the game
   */
  static BeginGame(){
    this.Tables[0].turnState = PazaakTurnState.DRAW_CARD;
    this.Tables[1].turnState = PazaakTurnState.WAITING;
    this.TurnMode = PazaakTurnMode.PLAYER;
    this.Won = false;
    this.LastPayout = 0;
    this.LastRoundResult = PazaakRoundResult.TIE;

    const tableCount = this.Tables.length;
    for(let i = 0; i < tableCount; i++){
      const table = this.Tables[i];
      const sideDeck = !i ? this.PlayerSideDeck : this.OpponentSideDeck;
      table.points = 0;
      table.winCount = 0;
      table.stand = false;
      table.handCardPlayed = false;

      //Copy the side decks to the player and opponent tables
      for(let j = 0; j < PazaakSideDeckSlots.MAX_SLOTS; j++){
        table.sideDeck.set(j, sideDeck.get(j));
      }

      //Initialize the player's table
      for(let j = 0; j < PazaakTableSlots.MAX_SLOTS; j++){
        table.cardArea.set(j, undefined);
      }

      /**
       * Deal the match hand: distinct side deck slots, 4 cards
       */
      const deckCards: PazaakCards[] = [];
      for(let j = 0; j < PazaakSideDeckSlots.MAX_SLOTS; j++){
        deckCards.push(table.sideDeck.get(j));
      }
      const hand = dealHand(
        deckCards,
        (card) => card != undefined && card != PazaakCards.INVALID,
        PazaakHandSlots.MAX_SLOTS,
        this.Random
      );
      if(hand.length < PazaakHandSlots.MAX_SLOTS){
        console.warn(`PazaakManager: Only ${hand.length} side deck cards available for player ${i}`);
      }
      for(let j = 0; j < PazaakHandSlots.MAX_SLOTS; j++){
        table.handCards.set(j, j < hand.length ? hand[j] : PazaakCards.INVALID);
        table.flipCards.set(j, false);
        table.swapValueCards.set(j, false);
      }
    }

    this.ClearActions();
    this.AddAction(this.TurnMode, PazaakActionType.BEGIN_ROUND, [PazaakTurnMode.PLAYER]);
  }

  /**
   * Play a card from the player's hand
   * @param handIndex - The index of the card to play
   */
  static AddPlayHandCardAction(tableIndex: number, handIndex: number, flipped: boolean = false, swapped: boolean = !!this.Tables[tableIndex].swapValueCards.get(handIndex)){
    this.AddActionFront(tableIndex, PazaakActionType.PLAY_HAND_CARD, [tableIndex, handIndex, flipped ? 1 : 0, swapped ? 1 : 0]);
  }

  /**
   * End the turn
   */
  static AddEndTurnAction(tableIndex: number){
    this.ClearActions();
    this.AddAction(tableIndex, PazaakActionType.END_TURN, [tableIndex, 0]);
  }

  /**
   * Player stands
   */
  static AddStandAction(tableIndex: number  ){
    this.ClearActions();
    this.AddAction(tableIndex, PazaakActionType.END_TURN, [tableIndex, 1]);
  }

}
