import type { IPazaakCard } from "@/interface/minigames/IPazaakCard";

/**
 * PazaakRules
 *
 * Pure, GUI-free Pazaak rule functions shared by K1 and TSL.
 * PazaakManager drives the action queue and the GUI; every rule decision
 * (scoring, bust, nine-card win, round/match winner, card effects, AI choice,
 * wager payout) lives here so it can be tested without the engine.
 *
 * KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
 *
 * @file PazaakRules.ts
 * @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
 */

export const PAZAAK_TARGET_POINTS = 20;
export const PAZAAK_TABLE_SLOTS = 9;
export const PAZAAK_TARGET_WINS = 3;
export const PAZAAK_MAIN_DECK_COPIES = 4;
export const PAZAAK_MAIN_DECK_MAX_VALUE = 10;

export enum PazaakRoundResult {
  TIE = -1,
  PLAYER = 0,
  OPPONENT = 1,
}

export enum PazaakEndOfTurn {
  CONTINUE = 0,
  STAND = 1,
  BUST = 2,
  /** Nine cards on the table without busting wins the round outright. */
  FILLED_TABLE = 3,
}

export interface IPazaakPlayOptions {
  /** Use the card's negative side (reversible cards only). */
  flipped?: boolean;
  /** Use the card's alternate value (TSL 1±2 card only). */
  swapped?: boolean;
}

export interface IPazaakSide {
  /** Resolved value of every card on this side of the table, in play order. */
  values: number[];
  /** True if a TSL tiebreaker card was played on this side this round. */
  tiebreaker?: boolean;
}

/**
 * Value a hand card contributes when played, ignoring table-wide effects.
 */
export function getCardModifier(card: IPazaakCard, opts: IPazaakPlayOptions = {}): number {
  const mods = (opts.swapped && card.altModifier) ? card.altModifier : card.modifier;
  return (opts.flipped && card.reversible) ? mods[1] : mods[0];
}

/**
 * Apply a card to a table and return the new list of resolved card values.
 * Flip cards rewrite existing values; the double card copies the last value.
 */
export function applyCardToTable(values: readonly number[], card: IPazaakCard, opts: IPazaakPlayOptions = {}): number[] {
  if(card.effect == 'flip'){
    const targets = card.flipValues || [];
    return values.map((v) => targets.includes(Math.abs(v)) ? -v : v).concat([0]);
  }
  if(card.effect == 'double'){
    const last = values.length ? values[values.length - 1] : 0;
    return values.concat([last]);
  }
  return values.concat([getCardModifier(card, opts)]);
}

export function sumTable(values: readonly number[]): number {
  let total = 0;
  for(const v of values) total += v;
  return total;
}

export function isBust(points: number, target: number = PAZAAK_TARGET_POINTS): boolean {
  return points > target;
}

/**
 * Evaluate a side at the END of its turn. Bust is only decided here, never
 * right after the draw, so a minus/flip card played after the draw can rescue.
 */
export function evaluateEndOfTurn(
  points: number, cardCount: number, standing: boolean, target: number = PAZAAK_TARGET_POINTS
): PazaakEndOfTurn {
  if(isBust(points, target)) return PazaakEndOfTurn.BUST;
  if(cardCount >= PAZAAK_TABLE_SLOTS) return PazaakEndOfTurn.FILLED_TABLE;
  if(standing || points == target) return PazaakEndOfTurn.STAND;
  return PazaakEndOfTurn.CONTINUE;
}

/**
 * Decide the winner of a finished round.
 * Order: bust loses, a filled table (9 cards, not bust) wins, then the higher
 * total wins; on equal totals a lone tiebreaker card wins, otherwise a tie.
 */
export function decideRoundWinner(
  player: IPazaakSide, opponent: IPazaakSide, target: number = PAZAAK_TARGET_POINTS
): PazaakRoundResult {
  const p = sumTable(player.values);
  const o = sumTable(opponent.values);
  const pBust = isBust(p, target);
  const oBust = isBust(o, target);
  if(pBust && !oBust) return PazaakRoundResult.OPPONENT;
  if(oBust && !pBust) return PazaakRoundResult.PLAYER;
  if(pBust && oBust) return PazaakRoundResult.TIE;

  const pFilled = player.values.length >= PAZAAK_TABLE_SLOTS;
  const oFilled = opponent.values.length >= PAZAAK_TABLE_SLOTS;
  if(pFilled && !oFilled) return PazaakRoundResult.PLAYER;
  if(oFilled && !pFilled) return PazaakRoundResult.OPPONENT;

  if(p > o) return PazaakRoundResult.PLAYER;
  if(o > p) return PazaakRoundResult.OPPONENT;

  if(player.tiebreaker && !opponent.tiebreaker) return PazaakRoundResult.PLAYER;
  if(opponent.tiebreaker && !player.tiebreaker) return PazaakRoundResult.OPPONENT;
  return PazaakRoundResult.TIE;
}

/**
 * @returns the index of the side that has reached the target win count, or -1.
 */
export function matchWinner(winCounts: readonly number[], targetWins: number = PAZAAK_TARGET_WINS): number {
  for(let i = 0; i < winCounts.length; i++){
    if(winCounts[i] >= targetWins) return i;
  }
  return -1;
}

/** Config `type` of main deck cards (side deck cards are type 1). */
export const PAZAAK_MAIN_CARD_TYPE = 0;

export interface IPazaakCardTextures {
  positive: string;
  negative: string;
}

/**
 * Label and texture for a card on the table, from its resolved value, so a
 * card rewritten by a flip card reads (and is coloured) as its new sign.
 * Flip cards contribute nothing and keep their own label/texture.
 */
export function getTableCardDisplay(card: IPazaakCard, textures: IPazaakCardTextures): { label: string, texture: string } {
  if(card.effect == 'flip'){
    return { label: card.modifierLabel, texture: card.textures[0] };
  }
  const value = card.value ?? card.modifier[0];
  const isMain = card.type == PAZAAK_MAIN_CARD_TYPE;
  const label = (value > 0 && !isMain) ? `+${value}` : `${value}`;
  let texture: string;
  if(card.effect){
    texture = card.textures[0];
  }else if(isMain){
    texture = value < 0 ? textures.negative : card.textures[0];
  }else if(card.reversible){
    texture = card.textures[value < 0 ? 1 : 0];
  }else{
    texture = value < 0 ? textures.negative : textures.positive;
  }
  return { label, texture };
}

/**
 * Clamp a wager to what the player can cover. If they can't afford the
 * minimum, the match is unwagered (0) rather than a bet they can't pay.
 */
export function clampWager(wager: number, minWager: number, maxWager: number, gold: number): number {
  const cap = Math.min(maxWager, Math.max(0, Math.floor(gold || 0)));
  if(cap < minWager) return 0;
  return Math.max(minWager, Math.min(Math.floor(wager || 0), cap));
}

/**
 * Credits moved to the player at match end. The wager is never deducted up
 * front, so the winner gains the wager and the loser loses it (not 2x).
 */
export function wagerPayout(playerWon: boolean, wager: number): number {
  const w = Math.max(0, Math.floor(wager || 0));
  return playerWon ? w : -w;
}

/**
 * A fresh main deck: four copies of each value 1-10.
 */
export function buildMainDeck(): number[] {
  const deck: number[] = [];
  for(let c = 0; c < PAZAAK_MAIN_DECK_COPIES; c++){
    for(let v = 1; v <= PAZAAK_MAIN_DECK_MAX_VALUE; v++){
      deck.push(v);
    }
  }
  return deck;
}

/**
 * Fisher-Yates shuffle (returns a new array).
 */
export function shuffle<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const out = items.slice();
  for(let i = out.length - 1; i > 0; i--){
    const j = Math.floor(rng() * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/**
 * Pick `count` distinct side-deck slots to form the match hand.
 * Slots, not card values, are drawn so a deck holding one +3 can't deal two.
 */
export function dealHand<T>(sideDeck: readonly T[], isValid: (card: T) => boolean, count: number, rng: () => number = Math.random): T[] {
  const slots: number[] = [];
  for(let i = 0; i < sideDeck.length; i++){
    if(isValid(sideDeck[i])) slots.push(i);
  }
  return shuffle(slots, rng).slice(0, count).map((i) => sideDeck[i]);
}

//----//
// AI //
//----//

export interface IPazaakAIContext {
  playerPoints: number;
  playerStanding: boolean;
  target?: number;
}

export interface IPazaakAIMove {
  /** Hand slot to play, or -1 to play nothing. */
  handIndex: number;
  flipped: boolean;
  swapped: boolean;
  /** Whether to stand after this move. */
  stand: boolean;
}

/**
 * Whether the AI should stand on `total`.
 */
export function aiShouldStand(total: number, ctx: IPazaakAIContext): boolean {
  const target = ctx.target ?? PAZAAK_TARGET_POINTS;
  if(total > target) return false;
  if(total == target) return true;
  if(ctx.playerStanding){
    if(total > ctx.playerPoints) return true;
    // A tie replays the round; take it rather than risk a likely bust.
    return total == ctx.playerPoints && total >= 17;
  }
  return total >= 18;
}

function playVariants(card: IPazaakCard): IPazaakPlayOptions[] {
  const variants: IPazaakPlayOptions[] = [{ flipped: false, swapped: false }];
  if(card.reversible) variants.push({ flipped: true, swapped: false });
  if(card.altModifier){
    variants.push({ flipped: false, swapped: true });
    if(card.reversible) variants.push({ flipped: true, swapped: true });
  }
  return variants;
}

/**
 * Choose the AI's move after its draw.
 * @param values - resolved values on the AI's table (including the card just drawn)
 * @param hand - the AI's hand; undefined entries are already-played slots
 */
export function chooseAIMove(values: readonly number[], hand: readonly (IPazaakCard | undefined)[], ctx: IPazaakAIContext): IPazaakAIMove {
  const target = ctx.target ?? PAZAAK_TARGET_POINTS;
  const current = sumTable(values);
  const tableFull = values.length >= PAZAAK_TABLE_SLOTS;

  const options: { handIndex: number, opts: IPazaakPlayOptions, total: number }[] = [];
  if(!tableFull){
    hand.forEach((card, handIndex) => {
      if(!card) return;
      for(const opts of playVariants(card)){
        options.push({ handIndex, opts, total: sumTable(applyCardToTable(values, card, opts)) });
      }
    });
  }

  const best = (accept: (total: number) => boolean) => {
    let pick: typeof options[number] | undefined;
    for(const o of options){
      if(o.total > target || !accept(o.total)) continue;
      if(!pick || o.total > pick.total) pick = o;
    }
    return pick;
  };

  const play = (o: typeof options[number]): IPazaakAIMove => ({
    handIndex: o.handIndex,
    flipped: !!o.opts.flipped,
    swapped: !!o.opts.swapped,
    stand: aiShouldStand(o.total, ctx),
  });
  const noPlay = (): IPazaakAIMove => ({
    handIndex: -1, flipped: false, swapped: false, stand: aiShouldStand(current, ctx),
  });

  // Over 20 after the draw: rescue at any total, or accept the bust.
  if(current > target){
    const rescue = best(() => true);
    return rescue ? play(rescue) : noPlay();
  }

  // Eighth card down: any non-busting hand card fills the table and wins.
  if(values.length == PAZAAK_TABLE_SLOTS - 1){
    const fill = best(() => true);
    if(fill) return play(fill);
  }

  if(current == target) return noPlay();

  // Close to 20: spend a card only to hit exactly 20.
  if(current >= 17){
    const exact = best((t) => t == target);
    if(exact) return play(exact);
  }

  if(aiShouldStand(current, ctx)) return noPlay();

  if(current >= 15 || ctx.playerStanding){
    const good = best((t) => aiShouldStand(t, ctx));
    if(good) return play(good);
  }

  return noPlay();
}
