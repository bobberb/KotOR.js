import { describe, expect, test } from '@jest/globals';
import {
  PAZAAK_TABLE_SLOTS, PazaakEndOfTurn, PazaakRoundResult,
  aiShouldStand, applyCardToTable, buildMainDeck, chooseAIMove, dealHand,
  decideRoundWinner, evaluateEndOfTurn, getCardModifier, matchWinner, shuffle, sumTable, wagerPayout,
  clampWager, getTableCardDisplay,
} from '@/engine/minigames/PazaakRules';
import { PazaakConfig as K1Config } from '@/game/kotor/minigames/mg-pazaak-config';
import { PazaakConfig as TSLConfig } from '@/game/tsl/minigames/mg-pazaak-config';
import { PazaakCards } from '@/enums/minigames/PazaakCards';
import { PazaakDeck } from '@/engine/minigames/PazaakDeck';
import type { IPazaakCard } from '@/interface/minigames/IPazaakCard';

const k1 = (i: PazaakCards) => K1Config.data.sideDeckCards[i] as IPazaakCard;
const tsl = (i: PazaakCards) => TSLConfig.data.sideDeckCards[i] as IPazaakCard;

describe('card values', () => {
  test('plus, minus and plus/minus cards resolve to the chosen sign', () => {
    expect(getCardModifier(k1(PazaakCards.PLUS_3))).toBe(3);
    expect(getCardModifier(k1(PazaakCards.MINUS_4))).toBe(-4);
    expect(getCardModifier(k1(PazaakCards.PLUS_MINUS_2))).toBe(2);
    expect(getCardModifier(k1(PazaakCards.PLUS_MINUS_2), { flipped: true })).toBe(-2);
  });

  test('flipping a non-reversible card does not zero it', () => {
    // modifier[1] of a +3 card is 0; the old code read it when the GUI flip toggle was set
    expect(getCardModifier(k1(PazaakCards.PLUS_3), { flipped: true })).toBe(3);
  });

  test('TSL 1±2 card offers +1, -1, +2, -2', () => {
    const card = tsl(PazaakCards.TSL_PLUS_MINUS_1_OR_2);
    expect(getCardModifier(card)).toBe(1);
    expect(getCardModifier(card, { flipped: true })).toBe(-1);
    expect(getCardModifier(card, { swapped: true })).toBe(2);
    expect(getCardModifier(card, { flipped: true, swapped: true })).toBe(-2);
  });

  test('TSL flip 2&4 flips the sign of every 2 and 4 on the table', () => {
    const after = applyCardToTable([2, 4, 10, -4, 3], tsl(PazaakCards.TSL_FLIP_2_4));
    expect(after).toEqual([-2, -4, 10, 4, 3, 0]);
    expect(sumTable(after)).toBe(11);
  });

  test('TSL flip 3&6 flips 3s and 6s only', () => {
    expect(applyCardToTable([3, 6, 9, 2], tsl(PazaakCards.TSL_FLIP_3_6))).toEqual([-3, -6, 9, 2, 0]);
  });

  test('TSL double card doubles the last table card', () => {
    const after = applyCardToTable([10, 5], tsl(PazaakCards.TSL_DOUBLE));
    expect(after).toEqual([10, 5, 5]);
    expect(sumTable(after)).toBe(20);
    expect(applyCardToTable([10, -3], tsl(PazaakCards.TSL_DOUBLE))).toEqual([10, -3, -3]);
  });

  test('TSL tiebreaker is a ±1 card tagged as tiebreaker', () => {
    const card = tsl(PazaakCards.TSL_TIEBREAKER);
    expect(card.effect).toBe('tiebreaker');
    expect(getCardModifier(card)).toBe(1);
    expect(getCardModifier(card, { flipped: true })).toBe(-1);
  });
});

describe('end of turn', () => {
  test('over 20 at end of turn busts', () => {
    expect(evaluateEndOfTurn(21, 3, false)).toBe(PazaakEndOfTurn.BUST);
    expect(evaluateEndOfTurn(21, 3, true)).toBe(PazaakEndOfTurn.BUST);
  });
  test('exactly 20 stands automatically', () => {
    expect(evaluateEndOfTurn(20, 3, false)).toBe(PazaakEndOfTurn.STAND);
  });
  test('nine cards without busting fills the table', () => {
    expect(evaluateEndOfTurn(17, PAZAAK_TABLE_SLOTS, false)).toBe(PazaakEndOfTurn.FILLED_TABLE);
    expect(evaluateEndOfTurn(20, PAZAAK_TABLE_SLOTS, true)).toBe(PazaakEndOfTurn.FILLED_TABLE);
    expect(evaluateEndOfTurn(22, PAZAAK_TABLE_SLOTS, false)).toBe(PazaakEndOfTurn.BUST);
  });
  test('otherwise continue unless standing', () => {
    expect(evaluateEndOfTurn(15, 3, false)).toBe(PazaakEndOfTurn.CONTINUE);
    expect(evaluateEndOfTurn(15, 3, true)).toBe(PazaakEndOfTurn.STAND);
  });
});

describe('round winner', () => {
  test('bust loses', () => {
    expect(decideRoundWinner({ values: [10, 10, 2] }, { values: [5] })).toBe(PazaakRoundResult.OPPONENT);
    expect(decideRoundWinner({ values: [5] }, { values: [10, 10, 2] })).toBe(PazaakRoundResult.PLAYER);
  });
  test('higher total wins, exactly 20 is not an auto-win against nothing', () => {
    expect(decideRoundWinner({ values: [10, 9] }, { values: [10, 8] })).toBe(PazaakRoundResult.PLAYER);
    expect(decideRoundWinner({ values: [10, 8] }, { values: [10, 10] })).toBe(PazaakRoundResult.OPPONENT);
  });
  test('nine cards beats a higher total', () => {
    const nine = [2, 2, 2, 2, 2, 2, 2, 2, 1];
    expect(decideRoundWinner({ values: nine }, { values: [10, 10] })).toBe(PazaakRoundResult.PLAYER);
    expect(decideRoundWinner({ values: [10, 10] }, { values: nine })).toBe(PazaakRoundResult.OPPONENT);
  });
  test('equal totals tie', () => {
    expect(decideRoundWinner({ values: [10, 9] }, { values: [9, 10] })).toBe(PazaakRoundResult.TIE);
  });
  test('a lone tiebreaker wins the tie; two tiebreakers still tie', () => {
    expect(decideRoundWinner({ values: [10, 9], tiebreaker: true }, { values: [9, 10] })).toBe(PazaakRoundResult.PLAYER);
    expect(decideRoundWinner({ values: [10, 9] }, { values: [9, 10], tiebreaker: true })).toBe(PazaakRoundResult.OPPONENT);
    expect(decideRoundWinner({ values: [10, 9], tiebreaker: true }, { values: [9, 10], tiebreaker: true })).toBe(PazaakRoundResult.TIE);
  });
  test('tiebreaker does not beat a higher total', () => {
    expect(decideRoundWinner({ values: [10, 8], tiebreaker: true }, { values: [9, 10] })).toBe(PazaakRoundResult.OPPONENT);
  });
});

describe('match and wager', () => {
  test('first to 3 round wins takes the match', () => {
    expect(matchWinner([2, 2])).toBe(-1);
    expect(matchWinner([3, 1])).toBe(0);
    expect(matchWinner([2, 3])).toBe(1);
  });
  test('payout is +wager on win, -wager on loss (wager is not pre-deducted)', () => {
    expect(wagerPayout(true, 100)).toBe(100);
    expect(wagerPayout(false, 100)).toBe(-100);
    expect(wagerPayout(true, 0)).toBe(0);
  });
});

describe('decks', () => {
  test('main deck is four copies of 1-10', () => {
    const deck = buildMainDeck();
    expect(deck).toHaveLength(40);
    for(let v = 1; v <= 10; v++){
      expect(deck.filter((c) => c == v)).toHaveLength(4);
    }
  });
  test('shuffle is a permutation', () => {
    let seed = 1;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const deck = buildMainDeck();
    expect(shuffle(deck, rng).slice().sort((a, b) => a - b)).toEqual(deck.slice().sort((a, b) => a - b));
  });
  test('hand deal takes distinct side deck slots, never duplicating a single card', () => {
    const side = [PazaakCards.PLUS_3, PazaakCards.MINUS_2, PazaakCards.INVALID, PazaakCards.PLUS_MINUS_1, PazaakCards.MINUS_5];
    for(let s = 0; s < 50; s++){
      let seed = s + 1;
      const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const hand = dealHand(side, (c) => c != PazaakCards.INVALID, 4, rng);
      expect(hand.slice().sort()).toEqual([PazaakCards.PLUS_3, PazaakCards.MINUS_2, PazaakCards.PLUS_MINUS_1, PazaakCards.MINUS_5].sort());
    }
  });
  test('TSL pazaakdecks.2da labels map to the TSL config card with the matching effect', () => {
    expect(tsl(PazaakDeck.ModifierToCardIndex('$$')).effect).toBe('double');
    expect(tsl(PazaakDeck.ModifierToCardIndex('TT')).effect).toBe('tiebreaker');
    expect(tsl(PazaakDeck.ModifierToCardIndex('F1')).flipValues).toEqual([2, 4]);
    expect(tsl(PazaakDeck.ModifierToCardIndex('F2')).flipValues).toEqual([3, 6]);
    expect(tsl(PazaakDeck.ModifierToCardIndex('VV')).altModifier).toEqual([2, -2]);
    expect(PazaakDeck.ModifierToCardIndex('+-3')).toBe(PazaakCards.PLUS_MINUS_3);
    expect(PazaakDeck.ModifierToCardIndex('bogus')).toBe(-1);
  });
  test('main deck config index v-1 holds value v in both games', () => {
    for(const cfg of [K1Config, TSLConfig]){
      cfg.data.mainDeckCards.forEach((c, i) => expect(c.modifier[0]).toBe(i + 1));
    }
  });
});

describe('AI', () => {
  const ctx = { playerPoints: 12, playerStanding: false };

  test('rescues a bust with a minus card, even below 18', () => {
    const move = chooseAIMove([10, 5, 8], [undefined, k1(PazaakCards.MINUS_6)], ctx);
    expect(move.handIndex).toBe(1);
    expect(move.stand).toBe(false);
  });

  test('rescue picks the best non-busting option and flips plus/minus cards', () => {
    const move = chooseAIMove([10, 9, 4], [k1(PazaakCards.MINUS_1), k1(PazaakCards.PLUS_MINUS_3)], ctx);
    expect(move).toEqual({ handIndex: 1, flipped: true, swapped: false, stand: true });
  });

  test('busted with no rescue plays nothing', () => {
    const move = chooseAIMove([10, 9, 4], [k1(PazaakCards.PLUS_1)], ctx);
    expect(move.handIndex).toBe(-1);
  });

  test('stands on 18-20 when the player has not stood', () => {
    expect(chooseAIMove([10, 8], [], ctx)).toMatchObject({ handIndex: -1, stand: true });
    expect(chooseAIMove([10, 7], [], ctx)).toMatchObject({ handIndex: -1, stand: false });
  });

  test('uses a card to hit exactly 20', () => {
    expect(chooseAIMove([10, 8], [k1(PazaakCards.PLUS_2)], ctx)).toMatchObject({ handIndex: 0, stand: true });
  });

  test('does not stand behind a standing player', () => {
    const behind = { playerPoints: 19, playerStanding: true };
    expect(aiShouldStand(18, behind)).toBe(false);
    expect(chooseAIMove([10, 8], [], behind)).toMatchObject({ handIndex: -1, stand: false });
    expect(chooseAIMove([10, 5], [k1(PazaakCards.PLUS_5)], behind)).toMatchObject({ handIndex: 0, stand: true });
  });

  test('fills the ninth slot when it can for the auto-win', () => {
    const eight = [1, 1, 1, 1, 1, 1, 1, 1];
    expect(chooseAIMove(eight, [k1(PazaakCards.PLUS_1)], ctx)).toMatchObject({ handIndex: 0 });
  });
});

describe('TSL card index order', () => {
  test('keeps the upstream PazaakDeck order: $$=18 F1=19 F2=20 TT=21 VV=22', () => {
    expect(PazaakDeck.ModifierToCardIndex('$$')).toBe(18);
    expect(PazaakDeck.ModifierToCardIndex('F1')).toBe(19);
    expect(PazaakDeck.ModifierToCardIndex('F2')).toBe(20);
    expect(PazaakDeck.ModifierToCardIndex('TT')).toBe(21);
    expect(PazaakDeck.ModifierToCardIndex('VV')).toBe(22);
    expect(TSLConfig.data.sideDeckCards.slice(18).map((c: any) => c.name))
      .toEqual(['Double', 'Flip2&4', 'Flip 3&6', 'Tie Breaker', '1±2']);
  });
});

describe('table card display', () => {
  const k1Tex = { positive: 'lbl_cardmpos', negative: 'lbl_cardmneg' };
  const tslTex = { positive: 'pcards_pos_p', negative: 'pcards_neg_p' };
  const main = (cfg: any, v: number, value = v) => ({ ...cfg.data.mainDeckCards[v - 1], value });
  const side = (cfg: any, i: PazaakCards, value: number, flipped = false) => ({ ...cfg.data.sideDeckCards[i], value, flipped });

  test('main deck cards show their value; a flipped main card shows negative', () => {
    expect(getTableCardDisplay(main(TSLConfig, 10), tslTex)).toEqual({ label: '10', texture: 'pcards_generic_p' });
    expect(getTableCardDisplay(main(TSLConfig, 2, -2), tslTex)).toEqual({ label: '-2', texture: 'pcards_neg_p' });
    expect(getTableCardDisplay(main(K1Config, 4, -4), k1Tex)).toEqual({ label: '-4', texture: 'lbl_cardmneg' });
  });

  test('side cards show their signed resolved value', () => {
    expect(getTableCardDisplay(side(K1Config, PazaakCards.PLUS_3, 3), k1Tex)).toEqual({ label: '+3', texture: 'lbl_cardmpos' });
    expect(getTableCardDisplay(side(K1Config, PazaakCards.PLUS_MINUS_2, -2, true), k1Tex)).toEqual({ label: '-2', texture: 'lbl_cardraref' });
    // a +2 side card rewritten by Flip 2&4
    expect(getTableCardDisplay(side(TSLConfig, PazaakCards.PLUS_2, -2), tslTex)).toEqual({ label: '-2', texture: 'pcards_neg_p' });
    // a -4 side card rewritten by Flip 2&4
    expect(getTableCardDisplay(side(TSLConfig, PazaakCards.MINUS_4, 4), tslTex)).toEqual({ label: '+4', texture: 'pcards_pos_p' });
  });

  test('double shows the value it copied; flip keeps its own label', () => {
    expect(getTableCardDisplay(side(TSLConfig, PazaakCards.TSL_DOUBLE, 5), tslTex)).toEqual({ label: '+5', texture: 'pcards_gold_p' });
    expect(getTableCardDisplay(side(TSLConfig, PazaakCards.TSL_DOUBLE, -3), tslTex).label).toBe('-3');
    expect(getTableCardDisplay(side(TSLConfig, PazaakCards.TSL_FLIP_2_4, 0), tslTex)).toEqual({ label: '2&4', texture: 'pcards_gold_p' });
    expect(getTableCardDisplay(side(TSLConfig, PazaakCards.TSL_TIEBREAKER, -1, true), tslTex).label).toBe('-1');
  });
});

describe('wager clamp', () => {
  test('a player with no credits plays unwagered', () => {
    expect(clampWager(1, 1, 100, 0)).toBe(0);
    expect(clampWager(50, 1, 100, 0)).toBe(0);
  });
  test('wager is capped by gold and the script maximum, floored at the minimum', () => {
    expect(clampWager(100, 1, 100, 30)).toBe(30);
    expect(clampWager(100, 1, 40, 1000)).toBe(40);
    expect(clampWager(0, 1, 100, 1000)).toBe(1);
    expect(clampWager(5, 1, 0, 1000)).toBe(0);
  });
});
