export type PazaakCardEffect = 'double' | 'tiebreaker' | 'flip';

export interface IPazaakCard {
  name: string;
  type: number;
  modifier: number[];
  modifierLabel: string;
  reversible: boolean;
  negateModifier: boolean;
  textures: string[];
  flipped?: boolean;
  /** TSL special card behaviour; undefined for plain value cards. */
  effect?: PazaakCardEffect;
  /** Flip cards: absolute table values whose sign is flipped. */
  flipValues?: number[];
  /** TSL 1±2 card: the alternate [positive, negative] pair. */
  altModifier?: number[];
  /** Resolved value of this card once it is on the table. */
  value?: number;
}
