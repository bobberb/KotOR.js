import { beforeEach, describe, expect, jest, test } from '@jest/globals';

/**
 * Starting a new game must not inherit the party table of a save loaded earlier in the session.
 *
 * Drives the real CharGenManager.startNewGame (the single path every K1/TSL Quick/Custom new
 * game takes) against the real PartyManager: load a TSL PARTYTABLE full of state, start a new
 * game, and check the new game has the chargen protagonist and nothing from the save.
 */

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/gui', () => ({ GameMenu: class {}, LBL_3DView: class {} }));
jest.mock('@/audio/AudioLoader', () => ({ AudioLoader: class {} }));
jest.mock('@/engine/CurrentGame', () => ({ CurrentGame: { InitGameInProgressFolder: jest.fn(async () => undefined), gameinprogress_dir: 'gip', WriteFile: jest.fn() } }));
jest.mock('@/utility/GameFileSystem', () => ({ GameFileSystem: { readFile: async () => new Uint8Array() } }));
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
import { PartyManager } from '@/managers/PartyManager';
import { ModulePlayer } from '@/module/ModulePlayer';
import { GFFObject } from '@/resource/GFFObject';
import { GFFField } from '@/resource/GFFField';
import { GFFStruct } from '@/resource/GFFStruct';
import { GFFDataType } from '@/enums/resource/GFFDataType';
import { GameEngineType } from '@/enums/engine/GameEngineType';

const state = GameState as any;

function soldierClass(): any {
  return {
    id: 0, level: 1, hitdie: 10, forcedie: 0,
    savingThrows: [{ level: 1, fortsave: 2, refsave: 1, willsave: 3 }],
    isFeatGrantedAtLevel: () => false,
    getACBonus: () => 0,
    save: () => new GFFStruct(),
  };
}

/** A TSL PARTYTABLE as a mid-game save writes it. */
function midGamePartyTable(): GFFObject {
  const gff = new GFFObject();
  const root = gff.RootNode;
  root.addField(new GFFField(GFFDataType.DWORD, 'PT_GOLD')).setValue(4000);
  root.addField(new GFFField(GFFDataType.INT, 'PT_XP_POOL')).setValue(900);
  root.addField(new GFFField(GFFDataType.BYTE, 'PT_SOLOMODE')).setValue(1);
  root.addField(new GFFField(GFFDataType.BYTE, 'PT_DISABLEREGEN')).setValue(1);
  root.addField(new GFFField(GFFDataType.INT, 'PT_SWOOP1')).setValue(2);
  const influence = root.addField(new GFFField(GFFDataType.LIST, 'PT_INFLUENCE'));
  const avail = root.addField(new GFFField(GFFDataType.LIST, 'PT_AVAIL_NPCS'));
  for(let i = 0; i < 12; i++){
    const inf = new GFFStruct();
    inf.addField(new GFFField(GFFDataType.INT, 'PT_NPC_INFLUENCE')).setValue(90);
    influence.addChildStruct(inf);
    const a = new GFFStruct();
    a.addField(new GFFField(GFFDataType.BYTE, 'PT_NPC_AVAIL')).setValue(1);
    a.addField(new GFFField(GFFDataType.BYTE, 'PT_NPC_SELECT')).setValue(1);
    avail.addChildStruct(a);
  }
  const pups = root.addField(new GFFField(GFFDataType.LIST, 'PT_PUPPETS'));
  const pup = new GFFStruct();
  pup.addField(new GFFField(GFFDataType.DWORD, 'PT_PUPPET_ID')).setValue(0);
  pups.addChildStruct(pup);
  const members = root.addField(new GFFField(GFFDataType.LIST, 'PT_MEMBERS'));
  const member = new GFFStruct();
  member.addField(new GFFField(GFFDataType.BYTE, 'PT_IS_LEADER')).setValue(0);
  member.addField(new GFFField(GFFDataType.INT, 'PT_MEMBER_ID')).setValue(0);
  members.addChildStruct(member);
  return gff;
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  state.CharGenManager = CharGenManager;
  state.PartyManager = PartyManager;
  state.SWRuleSet = { skills: [], ranges: [], portraits: [], feats: [], classes: [] };
  state.ModuleObjectManager = { AddObjectById: jest.fn(), GetNextPlayerId: jest.fn(() => 1) };
  state.FactionManager = { factions: new Map(), AddCreatureToFaction: jest.fn() };
  state.AppearanceManager = { GetCreatureAppearanceById: (): undefined => undefined };
  state.ActionFactory = { FromStruct: jest.fn(() => undefined) };
  state.TwoDAManager = { datatables: new Map() };
  state.TutorialWindowTracker = [];
  state.Planetary = { LoadStruct: jest.fn() };
  const messages = () => ({ ClearEntries: jest.fn(), AddEntry: jest.fn() });
  state.JournalManager = messages();
  state.DialogMessageManager = messages();
  state.FeedbackMessageManager = messages();
  state.GlobalVariableManager = { Init: jest.fn() };
  state.LoadModule = jest.fn();
});

describe.each([GameEngineType.TSL, GameEngineType.KOTOR])('new game after loading a save (%s)', (game) => {
  test('starts from a clean party table and keeps the chargen protagonist', async () => {
    state.GameKey = GameEngineType.TSL;
    PartyManager.Initialize();
    await PartyManager.Load(midGamePartyTable());
    expect([PartyManager.Gold, state.SOLOMODE, PartyManager.CurrentMembers.length]).toEqual([4000, true, 1]);

    state.GameKey = game;
    const player = new ModulePlayer(new GFFObject());
    player.classes = [soldierClass()];
    player.firstName = 'Exile';
    CharGenManager.selectedCreature = player;
    await CharGenManager.startNewGame();

    expect(state.LoadModule).toHaveBeenCalledWith(CharGenManager.getStartModule());
    expect(PartyManager.ActualPlayerTemplate).toBe(PartyManager.PlayerTemplate);
    expect(PartyManager.PlayerTemplate.RootNode.getFieldByLabel('IsPC').getValue()).toBe(1);

    expect({
      gold: PartyManager.Gold, xp: PartyManager.XPPool, solo: state.SOLOMODE, noRegen: state.disableHealthRegen,
      swoop: PartyManager.SwoopUpgrade1, influence: PartyManager.InfluenceMap.get(0), npc0: PartyManager.NPCS[0].available,
      members: PartyManager.CurrentMembers, puppets: PartyManager.PuppetMembers,
      maxParty: PartyManager.MaxPartyCount,
    }).toEqual({
      gold: 0, xp: 0, solo: false, noRegen: false, swoop: -1, influence: PartyManager.INFLUENCE_DEFAULT, npc0: false,
      members: [], puppets: [], maxParty: game == GameEngineType.TSL ? 12 : 9,
    });
  });
});
