import { beforeEach, describe, expect, jest, test } from '@jest/globals';

/**
 * Character generation must leave the class base saving throw counted once.
 *
 * ModuleCreature.getFortitudeSave() is class base (classes.2da cls_st_*) +
 * fortbonus + fortitudeSaveThrow. A merge left the Attributes screen's Accept
 * calling CharGenManager.syncDerivedStats(), which wrote the class base into
 * BOTH fortbonus and fortitudeSaveThrow (and the ref/will pairs): the save was
 * three times the base on the summary panel, and finalizeCreature() only
 * zeroes the *bonus fields, so the new PC kept twice the base for good. Both
 * games share the handler (TSL's CharGenAbilities calls the K1 wireControls).
 *
 * This drives the real Accept listener, the real finalizeCreature() and a real
 * save -> load of the creature.
 */

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/gui', () => ({ GameMenu: class {}, LBL_3DView: class {} }));
// The TSL screen extends the K1 one through the game barrel; only that export is needed.
jest.mock('@/game/kotor/KOTOR', () => ({
  CharGenAbilities: (jest.requireActual('@/game/kotor/menu/CharGenAbilities') as any).CharGenAbilities,
}));
jest.mock('@/audio/AudioLoader', () => ({ AudioLoader: class {} }));
jest.mock('@/engine/CurrentGame', () => ({ CurrentGame: { InitGameInProgressFolder: jest.fn(async () => undefined) } }));
jest.mock('@/utility/GameFileSystem', () => ({ GameFileSystem: {} }));
jest.mock('@/loaders/ResourceLoader', () => ({ ResourceLoader: {} }));
jest.mock('@/loaders', () => ({ MDLLoader: {}, ResourceLoader: {} }));
jest.mock('@/odyssey', () => ({
  OdysseyModel: class {}, OdysseyModelAnimation: class {}, OdysseyWalkMesh: class {},
}));
jest.mock('@/three/odyssey', () => {
  const THREE = jest.requireActual('three') as typeof import('three');
  return {
    OdysseyModel3D: class {}, OdysseyObject3D: class extends THREE.Object3D {}, OdysseyLightsaberEffect: class {},
  };
});
jest.mock('@/nwscript/NWScript', () => ({ NWScript: class {} }));
jest.mock('@/nwscript/NWScriptInstance', () => ({ NWScriptInstance: class {} }));
jest.mock('@/nwscript/events', () => ({ NWScriptEvent: class {} }));
jest.mock('@/engine/CollisionManager', () => ({ CollisionManager: class {} }));
jest.mock('@/combat', () => ({ CombatRound: class {}, CombatRoundAction: class {} }));

import { GameState } from '@/GameState';
import { CharGenManager } from '@/managers/CharGenManager';
import { CharGenAbilities } from '@/game/kotor/menu/CharGenAbilities';
import { CharGenAbilities as TSLCharGenAbilities } from '@/game/tsl/menu/CharGenAbilities';
import { ModuleCreature } from '@/module/ModuleCreature';
import { ModulePlayer } from '@/module/ModulePlayer';
import { GFFObject } from '@/resource/GFFObject';

const state = GameState as any;

const CLASS_BASE = { fortsave: 2, refsave: 1, willsave: 3 };

function soldierClass(): any {
  return {
    id: 0,
    level: 1,
    hitdie: 10,
    forcedie: 0,
    savingThrows: [{ level: 1, ...CLASS_BASE }],
    isFeatGrantedAtLevel: () => false,
    getACBonus: () => 0,
    save: () => {
      // ModuleCreature.save() writes ClassList from CreatureClass.save(); the
      // round trip under test is about the save fields, not the class list.
      const { GFFStruct } = jest.requireActual('@/resource/GFFStruct') as typeof import('@/resource/GFFStruct');
      return new GFFStruct();
    },
  };
}

function chargenCreature(): ModuleCreature {
  const creature = new ModuleCreature(new GFFObject());
  creature.classes = [soldierClass()];
  creature.firstName = 'Revan';
  creature.str = creature.dex = creature.con = creature.wis = creature.int = creature.cha = 14;
  return creature;
}

/** Click Accept on the Attributes screen exactly as the GUI does. */
function acceptAttributes(Screen: typeof CharGenAbilities, creature: ModuleCreature){
  const listeners: Record<string, () => void> = {};
  const button = () => ({
    addEventListener: (_event: string, fn: (e: any) => void) => { listeners.accept = () => fn({ stopPropagation() {} }); },
  });
  const screen = Object.create(Screen.prototype);
  screen.BTN_ACCEPT = button();
  screen.creature = creature;
  screen.close = jest.fn();
  screen.getControlByName = (): undefined => undefined;
  screen.manager = { CharGenMain: { updateAttributes: () => CharGenManager.applyDerivedStats(creature) } };
  screen.wireControls();
  listeners.accept();
  expect(screen.close).toHaveBeenCalled();
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  state.CharGenManager = CharGenManager;
  state.SWRuleSet = { skills: [], ranges: [], portraits: [], feats: [], classes: [] };
  state.ModuleObjectManager = { AddObjectById: jest.fn(), GetNextPlayerId: jest.fn(() => 1) };
  state.FactionManager = { factions: new Map(), AddCreatureToFaction: jest.fn() };
  state.AppearanceManager = { GetCreatureAppearanceById: (): undefined => undefined };
  state.ActionFactory = { FromStruct: jest.fn(() => undefined) };
  state.TwoDAManager = { datatables: new Map() };
  CharGenManager.availPoints = 0;
  CharGenManager.str = CharGenManager.dex = CharGenManager.con = 14;
  CharGenManager.wis = CharGenManager.int = CharGenManager.cha = 14;
});

/**
 * Load a saved creature template the way a savegame does. The stand-in class
 * cannot be re-read from ClassList (that needs classes.2da), so the list is
 * dropped and the class reattached; everything else goes through the real
 * initProperties(), which swallows its own exceptions, so those are checked.
 */
function reloadSaved<T extends ModuleCreature>(Type: new (gff: GFFObject) => T, saved: GFFObject): T {
  const gff = new GFFObject(saved.getExportBuffer());
  gff.RootNode.fields = gff.RootNode.fields.filter((field) => field.label !== 'ClassList');
  const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  errors.mockClear();
  const reloaded = new Type(gff);
  reloaded.initProperties();
  expect(errors.mock.calls.map((call) => call[0]).filter((first) => first instanceof Error)).toEqual([]);
  reloaded.classes = [soldierClass()];
  return reloaded;
}

function expectBaseOnce(creature: ModuleCreature){
  expect(creature.getFortitudeSave()).toBe(CLASS_BASE.fortsave);
  expect(creature.getReflexSave()).toBe(CLASS_BASE.refsave);
  expect(creature.getWillSave()).toBe(CLASS_BASE.willsave);
}

describe.each([
  ['K1', CharGenAbilities],
  ['TSL', TSLCharGenAbilities as unknown as typeof CharGenAbilities],
])('%s chargen counts the class base save once', (_game, Screen) => {
  test('after accepting attributes', () => {
    const creature = chargenCreature();
    acceptAttributes(Screen, creature);
    expectBaseOnce(creature);
    // Accept still derives vitality from the accepted CON (hitdie 10 + mod 2).
    expect(creature.maxHitPoints).toBe(12);
  });

  test('after finalizing and a save -> load', () => {
    const creature = chargenCreature();
    acceptAttributes(Screen, creature);
    CharGenManager.finalizeCreature(creature);
    expectBaseOnce(creature);

    const reloaded = reloadSaved(ModuleCreature, creature.save());
    expectBaseOnce(reloaded);
  });
});

describe('starting a new game', () => {
  test('the new protagonist is saved with IsPC 1', async () => {
    // Module load trusts IsPC=1 in Mod_PlayerList as the real protagonist; the
    // chargen template carries no IsPC, so without this the PC saved 0.
    const player = new ModulePlayer(new GFFObject());
    player.classes = [soldierClass()];
    player.firstName = 'Revan';
    expect(player.template.RootNode.hasField('IsPC')).toBe(false);
    const party: any = { AddPortraitToOrder: jest.fn(), ResetForNewGame: jest.fn(), IsProtagonist: () => true };
    state.PartyManager = party;
    state.GlobalVariableManager = { Init: jest.fn() };
    state.LoadModule = jest.fn();
    CharGenManager.selectedCreature = player;

    await CharGenManager.startNewGame();

    expect(state.LoadModule).toHaveBeenCalled();
    expect(party.ActualPlayerTemplate.RootNode.getFieldByLabel('IsPC').getValue()).toBe(1);
    const reloaded = reloadSaved(ModulePlayer, party.PlayerTemplate);
    expect(reloaded.isPC).toBe(1);
  });
});
