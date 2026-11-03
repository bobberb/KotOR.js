import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

/**
 * Module-level script events and the party death flow, executed for real.
 *
 * Before this suite Module loaded Mod_OnPlrDeath / Mod_OnAcquirItem / Mod_OnHeartbeat
 * / Mod_OnUsrDefined and friends but only ever ran OnModLoad and OnClientEnter;
 * a dead party leader kept control of a corpse and a wiped party stood there
 * forever; PopUpDeathGUIPanel, StartCreditSequence, GetModuleItemAcquiredFrom,
 * GetModuleItemLost* and GetItemActivated* were diagnostic stubs; SetLocal* on
 * GetModule() threw and the module's SWVarTable and Mod_Tokens were saved empty.
 *
 * Drives the real Module, PartyDeathMonitor, PartyManager, InventoryManager,
 * ModuleCreature, ModulePlaceable, ModuleItem equip paths, SaveGame inventory
 * restore, ActionGiveItem/ActionTakeItem, MenuStore purchases, the MenuGameOver
 * and MenuCredits classes and the NWScript routine bodies (through
 * buildRuntimeAction, i.e. with the VM's argument inflation). Module scripts are
 * stand-ins whose run() calls those routines, which is what a compiled .ncs does.
 */

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/utility/GameFileSystem', () => ({ GameFileSystem: {} }));
jest.mock('@/engine/CurrentGame', () => ({ CurrentGame: { WriteFile: jest.fn(), gameinprogress_dir: '/nonexistent' } }));
jest.mock('@/loaders/ResourceLoader', () => ({ ResourceLoader: {} }));
jest.mock('@/loaders', () => ({ MDLLoader: {}, ResourceLoader: {}, TextureLoader: { textures: new Map() } }));
jest.mock('@/KotOR', () => ({ ResourceTypes: (jest.requireActual('@/resource/ResourceTypes') as any).ResourceTypes }));
jest.mock('@/odyssey', () => ({
  OdysseyModel: class {}, OdysseyModelAnimation: class {}, OdysseyWalkMesh: class {},
}));
jest.mock('@/three/odyssey', () => {
  const THREE = jest.requireActual('three') as typeof import('three');
  return {
    OdysseyModel3D: class {}, OdysseyObject3D: class extends THREE.Object3D {}, OdysseyLightsaberEffect: class {},
  };
});
jest.mock('@/three/odyssey/OdysseyTexture', () => ({ OdysseyTexture: class {} }));
jest.mock('@/engine/TextSprite3D', () => {
  const THREE = jest.requireActual('three') as typeof import('three');
  return { TextSprite3D: class { container = new THREE.Object3D(); setColor() {} } };
});
jest.mock('@/module/ModuleArea', () => ({ ModuleArea: class {} }));
// The '@/module' barrel drags in the renderer; MenuStore only needs these three.
jest.mock('@/module', () => ({
  ModuleCreature: (jest.requireActual('@/module/ModuleCreature') as any).ModuleCreature,
  ModuleItem: (jest.requireActual('@/module/ModuleItem') as any).ModuleItem,
  ModuleStore: class {},
}));
jest.mock('@/nwscript/NWScript', () => ({ NWScript: class {} }));
jest.mock('@/nwscript/NWScriptInstance', () => ({ NWScriptInstance: class {} }));
jest.mock('@/engine/CollisionManager', () => ({ CollisionManager: class {} }));
jest.mock('@/combat', () => ({ CombatRound: class {}, CombatRoundAction: class {} }));
// The GUI layer is browser-only; GameMenu keeps the menu-stack contract the menus rely on.
jest.mock('@/gui', () => ({
  GameMenu: class {
    tGuiPanel: any; selectedControl: any; manager: any; gui_resref = ''; background = ''; voidFill = false; userCanClose = true;
    async menuControlInitializer() {}
    open() { this.manager.Add(this); }
    close() { this.manager.Remove(this); }
    update() {}
  },
}));

import { GameState } from '@/GameState';
import { GameFileSystem } from '@/utility/GameFileSystem';
import { Module } from '@/module/Module';
import { PartyDeathMonitor } from '@/module/PartyDeathMonitor';
import { ModuleCreature } from '@/module/ModuleCreature';
import { ModulePlaceable } from '@/module/ModulePlaceable';
import { ModuleItem } from '@/module/ModuleItem';
import { PartyManager } from '@/managers/PartyManager';
import { InventoryManager } from '@/managers/InventoryManager';
import { GameOver } from '@/engine/GameOver';
import { SaveGame } from '@/engine/SaveGame';
import { ActionGiveItem } from '@/actions/ActionGiveItem';
import { ActionTakeItem } from '@/actions/ActionTakeItem';
import { ActionStatus } from '@/enums/actions/ActionStatus';
import { MenuGameOver as K1MenuGameOver } from '@/game/kotor/menu/MenuGameOver';
import { MenuGameOver as TSLMenuGameOver } from '@/game/tsl/menu/MenuGameOver';
import { MenuCredits } from '@/game/kotor/menu/MenuCredits';
import { MenuStore } from '@/game/kotor/menu/MenuStore';
import { buildRuntimeAction } from '@/nwscript/builtins/actionBuilder';
import * as moduleRoutines from '@/nwscript/builtins/objects/module';
import * as localVarRoutines from '@/nwscript/builtins/localvars';
import * as eventRoutines from '@/nwscript/builtins/events';
import * as scriptingRoutines from '@/nwscript/builtins/scripting';
import * as queryRoutines from '@/nwscript/builtins/objects/query';
import * as combatRoutines from '@/nwscript/builtins/combat';
import * as objectCombatRoutines from '@/nwscript/builtins/objects/combat';
import * as perceptionRoutines from '@/nwscript/builtins/objects/perception';
import * as movementRoutines from '@/nwscript/builtins/movement';
import * as itemsLegacyRoutines from '@/nwscript/builtins/itemsLegacy';
import * as doorRoutines from '@/nwscript/builtins/doorsplaceables';
import * as equipmentRoutines from '@/nwscript/builtins/objects/equipment';
import * as miscLegacyRoutines from '@/nwscript/builtins/miscLegacy';
import { EventTimedEvent } from '@/events/EventTimedEvent';
import { ModuleObjectManager } from '@/managers/ModuleObjectManager';
import { ModuleObjectConstant } from '@/enums/module/ModuleObjectConstant';
import { ModuleTimeManager } from '@/module/ModuleTimeManager';
import { GetItemActivated, GetItemActivator } from '@/nwscript/builtins/missing';
import { GetModuleItemAcquired } from '@/nwscript/builtins/upstream/inventory';
import { ModuleObjectScript } from '@/enums/module/ModuleObjectScript';
import { ModuleObjectType } from '@/enums/module/ModuleObjectType';
import { MenuSaveLoadMode } from '@/enums/gui/MenuSaveLoadMode';
import { EngineMode } from '@/enums/engine/EngineMode';
import { GFFObject } from '@/resource/GFFObject';
import { GFFField } from '@/resource/GFFField';
import { GFFStruct } from '@/resource/GFFStruct';
import { GFFDataType } from '@/enums/resource/GFFDataType';

const state = GameState as any;

/** Calls a routine the way the VM does: raw stack arguments, inflated per the routine's params. */
function call(definition: any, instance: any, ...rawArgs: any[]) {
  // Preserved upstream bodies are already in the VM's raw-argument form.
  const action = typeof definition.action === 'function' ? definition.action : buildRuntimeAction(definition, 'kotor')!.action!;
  return action.call(instance, rawArgs);
}

interface ScriptRun { caller: any; scriptVar: number; instance: any }

/** A compiled module script stand-in: each run gets a fresh instance, as NWScript.Load would give. */
function stubScript(onRun: (instance: any, scriptVar: number) => void = () => {}) {
  const runs: ScriptRun[] = [];
  const script: any = {
    name: 'stub',
    newInstance() {
      const instance: any = {
        delayCommands: [] as any[],
        // What NWScriptInstance.run does around the bytecode: OBJECT_SELF is the
        // caller, and DelayCommands queue on the module once the script ends.
        run(caller: any, scriptVar = 0) {
          instance.caller = caller;
          instance.scriptVar = scriptVar;
          runs.push({ caller, scriptVar, instance });
          onRun(instance, scriptVar);
          state.module?.eventQueue.push(...instance.delayCommands);
          instance.delayCommands = [];
        },
      };
      return instance;
    },
  };
  return { script, runs };
}

function creature(tag: string, hp = 20): ModuleCreature {
  const gff = new GFFObject();
  gff.RootNode.addField(new GFFField(GFFDataType.CEXOSTRING, 'Tag')).setValue(tag);
  const c = new ModuleCreature(gff);
  c.subraceIndex = 0;
  c.maxHitPoints = 20;
  c.hitPoints = 20;
  c.currentHitPoints = hp;
  return c;
}

const kill = (c: ModuleCreature) => { c.currentHitPoints = 0; };

/** A running module: events are processed, the area and calendar are inert. */
function runningModule(): Module {
  const module = new Module();
  module.area = { update: jest.fn(), updatePaused: jest.fn(), creatures: [] } as any;
  module.timeManager = { update: jest.fn(), pauseDay: 0, pauseTime: 0 } as any;
  module.readyToProcessEvents = true;
  state.module = module;
  return module;
}

function tickFor(module: Module, seconds: number, step = 0.25) {
  for (let t = 0; t < seconds - 1e-9; t += step) module.tick(step);
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeItem {
  objectType = ModuleObjectType.ModuleObject | ModuleObjectType.ModuleItem;
  stack: number;
  tag: string;
  constructor(tagOrTemplate: string | GFFObject, stack = 1, public stackable = false) {
    this.tag = typeof tagOrTemplate === 'string' ? tagOrTemplate : tagOrTemplate.RootNode.getFieldByLabel('Tag').getValue();
    this.stack = stack;
  }
  initProperties() {}
  load() {}
  getStackSize() { return this.stack; }
  setStackSize(n: number) { this.stack = n; }
  getBaseItemId() { return 1; }
  getTag() { return this.tag; }
  canStackWith(other: any) { return this.stackable && other instanceof FakeItem && other.tag === this.tag; }
  clone() { return new FakeItem(this.tag, 1, this.stackable); }
}

/** A minimal MenuManager: the real menu stack contract (Add hides nothing, Remove pops). */
function menuManager() {
  const manager: any = {
    activeMenus: [] as any[],
    Add(menu: any) { if (manager.activeMenus.indexOf(menu) == -1) manager.activeMenus.push(menu); },
    Remove(menu: any) { const i = manager.activeMenus.indexOf(menu); if (i >= 0) manager.activeMenus.splice(i, 1); },
    MainMenu: { Start: jest.fn() },
  };
  manager.MenuSaveLoad = { mode: undefined as any, manager, open: jest.fn(function (this: any) { manager.Add(this); }), close() { manager.Remove(this); } };
  manager.MenuGameOver = undefined;
  manager.GetMenuGameOver = jest.fn(async () => {
    if (!manager.MenuGameOver) {
      const menu: any = new K1MenuGameOver();
      menu.manager = manager;
      menu.tGuiPanel = {};
      jest.spyOn(menu, 'open');
      manager.MenuGameOver = menu;
    }
    return manager.MenuGameOver;
  });
  return manager;
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(ModuleCreature.prototype, 'loadModel').mockReturnValue(new Promise(() => {}));
  jest.spyOn(ModuleCreature.prototype, 'getPortraitResRef').mockReturnValue('');

  state.Mode = EngineMode.INGAME;
  state.PartyManager = PartyManager;
  state.InventoryManager = InventoryManager;
  state.Module = { ModuleArea: { ModuleItem: FakeItem } };
  state.UINotificationManager = { EnableUINotificationIconType: jest.fn() };
  state.SWRuleSet = { skills: [], ranges: [], portraits: [], feats: [], classes: [] };
  state.ModuleObjectManager = { AddObjectById: jest.fn(), GetNextPlayerId: jest.fn(() => 1), GetObjectById: jest.fn() };
  state.FactionManager = { factions: new Map(), AddCreatureToFaction: jest.fn(), Export: jest.fn(async () => {}), IsHostile: () => false };
  state.AppearanceManager = { GetCreatureAppearanceById: (): undefined => undefined };
  state.ActionFactory = { FromStruct: jest.fn(() => undefined) };
  state.TwoDAManager = { datatables: new Map() };
  state.GetDebugState = () => false;
  state.MenuManager = menuManager();
  GameOver.opening = undefined;
  GameOver.pendingMessage = undefined;
  GameOver.creditsPending = false;

  PartyManager.party = [];
  PartyManager.CurrentMembers = [];
  PartyManager.Player = undefined;
  InventoryManager.inventory = [];
});

afterEach(() => jest.restoreAllMocks());

describe('party death', () => {
  test('the leader dies with a companion standing: control switches, no death script', () => {
    const module = runningModule();
    const death = stubScript();
    const dying = stubScript();
    module.scripts[ModuleObjectScript.ModuleOnPlayerDeath] = death.script;
    module.scripts[ModuleObjectScript.ModuleOnPlayerDying] = dying.script;
    const pc = creature('pc');
    const bastila = creature('bastila');
    PartyManager.party = [pc, bastila];

    kill(pc);
    module.tick(0.1);

    expect(PartyManager.party[0]).toBe(bastila);
    expect(state.currentLeader).toBe(bastila);
    expect(death.runs).toHaveLength(0);
    expect(dying.runs).toHaveLength(0);
    expect(state.MenuManager.GetMenuGameOver).not.toHaveBeenCalled();
  });

  test('the whole party down: Dying then Death run exactly once, each told who died, and PopUpDeathGUIPanel opens the death menu', async () => {
    const module = runningModule();
    const seen: any = {};
    const dying = stubScript((instance) => {
      seen.dyingEntering = instance.enteringObject;
      seen.dyingLastDying = call(moduleRoutines.GetLastPlayerDying, instance);
      seen.dyingLastDied = call(moduleRoutines.GetLastPlayerDied, instance);
    });
    const death = stubScript((instance) => {
      seen.deathEntering = instance.enteringObject;
      seen.deathLastDied = call(moduleRoutines.GetLastPlayerDied, instance);
      call(moduleRoutines.PopUpDeathGUIPanel, instance, PartyManager.party[0], 0, 0, 0, '');
    });
    module.scripts[ModuleObjectScript.ModuleOnPlayerDeath] = death.script;
    module.scripts[ModuleObjectScript.ModuleOnPlayerDying] = dying.script;
    const pc = creature('pc');
    const mission = creature('mission');
    PartyManager.party = [pc, mission];

    kill(pc);
    kill(mission);
    tickFor(module, 10);
    await flush();

    expect(dying.runs).toHaveLength(1);
    expect(death.runs).toHaveLength(1);
    expect(death.runs[0].caller).toBe(module);
    expect(seen.dyingEntering === pc).toBe(true);
    expect(seen.dyingLastDying === pc).toBe(true);
    expect(seen.dyingLastDied).toBeUndefined();
    expect(seen.deathEntering === pc).toBe(true);
    expect(seen.deathLastDied === pc).toBe(true);
    const menu = state.MenuManager.MenuGameOver;
    expect(menu.open).toHaveBeenCalledTimes(1);
    expect(state.MenuManager.activeMenus).toEqual([menu]);
  });

  test('a module without an OnPlrDeath script still gets the death menu, once', async () => {
    const module = runningModule();
    const pc = creature('pc');
    PartyManager.party = [pc];

    kill(pc);
    tickFor(module, 5);
    await flush();

    expect(state.MenuManager.GetMenuGameOver).toHaveBeenCalledTimes(1);
    expect(state.MenuManager.MenuGameOver.open).toHaveBeenCalledTimes(1);
  });

  test('the death screen cannot be closed with Escape, and comes back if it is closed anyway', async () => {
    const module = runningModule();
    const pc = creature('pc');
    PartyManager.party = [pc];
    kill(pc);
    module.tick(0.1);
    await flush();
    const menu = state.MenuManager.MenuGameOver;
    expect(menu.userCanClose).toBe(false);
    expect(new TSLMenuGameOver().userCanClose).toBe(false);

    menu.close();
    module.tick(0.1);
    await flush();

    expect(state.MenuManager.activeMenus).toEqual([menu]);
    expect(menu.open).toHaveBeenCalledTimes(2);
  });

  test('Back out of the load menu returns to the death screen, never the dead world', async () => {
    const module = runningModule();
    const pc = creature('pc');
    PartyManager.party = [pc];
    kill(pc);
    module.tick(0.1);
    await flush();

    GameOver.OpenLoadGame();
    module.tick(0.1);
    await flush();
    expect(state.MenuManager.MenuGameOver.open).toHaveBeenCalledTimes(1);

    state.MenuManager.MenuSaveLoad.close();
    state.MenuManager.MenuGameOver.close();
    module.tick(0.1);
    await flush();
    expect(state.MenuManager.activeMenus).toEqual([state.MenuManager.MenuGameOver]);
  });

  test('with the game over GUI missing, the load menu stands in and keeps coming back', async () => {
    const module = runningModule();
    const missing: any = { tGuiPanel: null, open: jest.fn() };
    state.MenuManager.GetMenuGameOver = jest.fn(async () => missing);
    const pc = creature('pc');
    PartyManager.party = [pc];
    kill(pc);
    module.tick(0.1);
    await flush();

    expect(missing.open).not.toHaveBeenCalled();
    expect(state.MenuManager.MenuSaveLoad.mode).toBe(MenuSaveLoadMode.LOADGAME);
    expect(state.MenuManager.MenuSaveLoad.open).toHaveBeenCalledTimes(1);

    // While it is up, it is the death screen: not stacked again every tick.
    tickFor(module, 1);
    await flush();
    expect(state.MenuManager.MenuSaveLoad.open).toHaveBeenCalledTimes(1);

    state.MenuManager.MenuSaveLoad.close();
    module.tick(0.1);
    await flush();
    expect(state.MenuManager.MenuSaveLoad.open).toHaveBeenCalledTimes(2);
  });

  test('a module death script that handles death itself is not overridden by the death screen', async () => {
    const module = runningModule();
    module.scripts[ModuleObjectScript.ModuleOnPlayerDeath] = stubScript().script;
    const pc = creature('pc');
    PartyManager.party = [pc];
    kill(pc);
    tickFor(module, 5);
    await flush();
    expect(state.MenuManager.GetMenuGameOver).not.toHaveBeenCalled();
  });

  test('the death screen is built once even if asked for again while it loads', async () => {
    runningModule();
    await Promise.all([GameOver.OpenDeathScreen(), GameOver.OpenDeathScreen()]);
    await GameOver.OpenDeathScreen();
    expect(state.MenuManager.GetMenuGameOver).toHaveBeenCalledTimes(2);
    expect(state.MenuManager.MenuGameOver.open).toHaveBeenCalledTimes(1);
  });

  test('an OnPlrDying script that saves someone cancels the death', () => {
    const module = runningModule();
    const pc = creature('pc');
    const death = stubScript();
    module.scripts[ModuleObjectScript.ModuleOnPlayerDeath] = death.script;
    module.scripts[ModuleObjectScript.ModuleOnPlayerDying] = stubScript(() => { pc.currentHitPoints = 5; }).script;
    PartyManager.party = [pc];

    kill(pc);
    module.tick(0.1);

    expect(death.runs).toHaveLength(0);
    expect(pc.isDead()).toBe(false);
  });

  test('after the party is back up, a second wipe runs the death script again', () => {
    const module = runningModule();
    const death = stubScript();
    module.scripts[ModuleObjectScript.ModuleOnPlayerDeath] = death.script;
    const pc = creature('pc');
    PartyManager.party = [pc];

    kill(pc);
    tickFor(module, 2);
    pc.currentHitPoints = 10;
    module.tick(0.25);
    kill(pc);
    tickFor(module, 2);

    expect(death.runs).toHaveLength(2);
  });

  test('members with no hit points loaded yet are not a wiped party', () => {
    const module = runningModule();
    const death = stubScript();
    module.scripts[ModuleObjectScript.ModuleOnPlayerDeath] = death.script;
    const loading = creature('pc', 0);
    loading.maxHitPoints = 0;
    loading.hitPoints = 0;
    PartyManager.party = [loading];

    tickFor(module, 2);

    expect(death.runs).toHaveLength(0);
  });

  test('nothing is judged during a minigame', () => {
    const module = runningModule();
    const death = stubScript();
    module.scripts[ModuleObjectScript.ModuleOnPlayerDeath] = death.script;
    const pc = creature('pc');
    PartyManager.party = [pc];
    state.Mode = EngineMode.MINIGAME;

    kill(pc);
    tickFor(module, 2);

    expect(death.runs).toHaveLength(0);
  });
});

describe('companion revival', () => {
  test('a companion who fell gets back up at 1 HP once combat is over', () => {
    const module = runningModule();
    const pc = creature('pc');
    const carth = creature('carth');
    PartyManager.party = [pc, carth];
    pc.combatData.combatState = true;

    kill(carth);
    tickFor(module, 10);
    expect(carth.isDead()).toBe(true);

    pc.combatData.combatState = false;
    module.tick(0.25);

    expect(carth.isDead()).toBe(false);
    expect(carth.getHP()).toBe(1);
    expect(PartyManager.party[0]).toBe(pc);
  });

  test('out of combat they stay down for the revive delay first', () => {
    const module = runningModule();
    const pc = creature('pc');
    const carth = creature('carth');
    PartyManager.party = [pc, carth];

    kill(carth);
    tickFor(module, 2.75);
    expect(carth.isDead()).toBe(true);
    tickFor(module, 0.25);
    expect(carth.getHP()).toBe(1);
  });

  test('a survivor who stopped fighting (kiting, Clear All) does not revive anyone next to a live hostile', () => {
    const module = runningModule();
    const pc = creature('pc');
    const carth = creature('carth');
    const sith = creature('sith');
    PartyManager.party = [pc, carth];
    (module.area as any).creatures = [sith];
    state.FactionManager.IsHostile = (a: any, b: any) => a === sith || b === sith;
    sith.position.set(10, 0, 0);

    kill(carth);
    tickFor(module, 10);
    expect(carth.isDead()).toBe(true);

    sith.position.set(PartyDeathMonitor.HOSTILE_RADIUS + 5, 0, 0);
    module.tick(0.25);
    expect(carth.getHP()).toBe(1);
  });

  test('party members standing in the area never count as the enemy', () => {
    const module = runningModule();
    const pc = creature('pc');
    const carth = creature('carth');
    PartyManager.party = [pc, carth];
    (module.area as any).creatures = [pc, carth];
    state.FactionManager.IsHostile = () => true;

    kill(carth);
    tickFor(module, 3.25);
    expect(carth.getHP()).toBe(1);
  });

  test('a dead hostile nearby does not hold the revive', () => {
    const module = runningModule();
    const pc = creature('pc');
    const carth = creature('carth');
    const sith = creature('sith');
    kill(sith);
    PartyManager.party = [pc, carth];
    (module.area as any).creatures = [sith];
    state.FactionManager.IsHostile = (a: any, b: any) => a === sith || b === sith;

    kill(carth);
    tickFor(module, 3.25);
    expect(carth.getHP()).toBe(1);
  });

  test('a fallen leader is revived after combat too, but control stays with the survivor', () => {
    const module = runningModule();
    const pc = creature('pc');
    const carth = creature('carth');
    PartyManager.party = [pc, carth];

    kill(pc);
    tickFor(module, PartyDeathMonitor.REVIVE_DELAY + 0.5);

    expect(PartyManager.party[0]).toBe(carth);
    expect(pc.getHP()).toBe(1);
  });

  test('time down is forgotten when a member leaves the party', () => {
    const module = runningModule();
    const pc = creature('pc');
    const carth = creature('carth');
    PartyManager.party = [pc, carth];
    pc.combatData.combatState = true;
    kill(carth);
    tickFor(module, 2.75);

    PartyManager.party = [pc];
    module.tick(0.25);
    PartyManager.party = [pc, carth];
    pc.combatData.combatState = false;
    tickFor(module, 0.5);
    expect(carth.isDead()).toBe(true);
    tickFor(module, 2.75);
    expect(carth.getHP()).toBe(1);
  });

  test('a wipe resets time down, so a member downed before it waits the full delay after a scripted rescue', () => {
    const module = runningModule();
    const pc = creature('pc');
    const carth = creature('carth');
    PartyManager.party = [pc, carth];
    pc.combatData.combatState = true;
    kill(carth);
    tickFor(module, 10);
    kill(pc);
    module.tick(0.25);

    pc.currentHitPoints = 10;
    pc.combatData.combatState = false;
    tickFor(module, 1);
    expect(carth.isDead()).toBe(true);
    tickFor(module, 2.25);
    expect(carth.getHP()).toBe(1);
  });

  test('nobody gets back up when the whole party is down', () => {
    const module = runningModule();
    const pc = creature('pc');
    const carth = creature('carth');
    PartyManager.party = [pc, carth];

    kill(pc);
    kill(carth);
    tickFor(module, 20);

    expect(pc.isDead()).toBe(true);
    expect(carth.isDead()).toBe(true);
  });

  test('the dead do not regenerate', () => {
    state.TwoDAManager.datatables.set('regeneration', { rows: [{ healthregen: '5', forceregen: '0' }, { healthregen: '5', forceregen: '0' }] });
    const carth = creature('carth');
    kill(carth);
    carth.regenTimer = 0;
    carth.updateRegen(1);
    expect(carth.getHP()).toBe(0);

    const living = creature('mission', 10);
    living.regenTimer = 0;
    living.updateRegen(1);
    expect(living.getHP()).toBe(15);
  });
});

describe('death menu', () => {
  function bind(menu: any) {
    const handlers: { [name: string]: () => void } = {};
    for (const name of ['BTN_LOADGAME', 'BTN_LASTSAVE', 'BTN_QUIT']) {
      menu[name] = { addEventListener: (_type: string, cb: (e: any) => void) => { handlers[name] = () => cb({ stopPropagation() {} }); } };
    }
    menu.bindButtons();
    return handlers;
  }

  test.each([
    ['K1', K1MenuGameOver, 'gameover'],
    ['TSL', TSLMenuGameOver, 'gameover_p'],
  ])('%s: Load Game opens the load menu, Quit returns to the main menu', (_game, MenuClass, resref) => {
    const menu: any = new (MenuClass as any)();
    expect(menu.gui_resref).toBe(resref);
    const handlers = bind(menu);

    handlers.BTN_LOADGAME();
    expect(state.MenuManager.MenuSaveLoad.mode).toBe(MenuSaveLoadMode.LOADGAME);
    expect(state.MenuManager.MenuSaveLoad.open).toHaveBeenCalledTimes(1);
    handlers.BTN_LASTSAVE();
    expect(state.MenuManager.MenuSaveLoad.open).toHaveBeenCalledTimes(2);

    const dispose = jest.fn();
    state.module = { dispose };
    state.UnloadModule = jest.fn();
    state.NWScript = { Reload: jest.fn() };
    state.controls = { initKeys: jest.fn() };
    handlers.BTN_QUIT();
    expect(state.UnloadModule).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(state.module).toBeUndefined();
    expect(state.NWScript.Reload).toHaveBeenCalled();
    expect(state.MenuManager.MainMenu.Start).toHaveBeenCalledTimes(1);
  });

  test('EndGame from a script inside Module.tick leaves the module in place for the rest of the frame', async () => {
    const module = runningModule();
    const dispose = jest.spyOn(module, 'dispose').mockImplementation(() => {});
    state.UnloadModule = jest.fn();
    state.NWScript = { Reload: jest.fn() };
    state.controls = { initKeys: jest.fn() };
    module.scripts[ModuleObjectScript.ModuleOnHeartbeat] = stubScript((instance) => call(moduleRoutines.EndGame, instance, 0)).script;

    tickFor(module, 6);
    // What GameState.UpdateIngame reads after module.tick in the same frame.
    expect(() => state.module.area.update).not.toThrow();
    expect(state.MenuManager.MainMenu.Start).not.toHaveBeenCalled();

    await flush();
    expect(dispose).toHaveBeenCalled();
    expect(state.module).toBeUndefined();
    expect(state.MenuManager.MainMenu.Start).toHaveBeenCalledTimes(1);
  });
});

describe('credits', () => {
  function creditsMenu(lines?: string[]) {
    const credits: any = new MenuCredits();
    credits.manager = state.MenuManager;
    credits.tGuiPanel = {};
    const items: string[] = [];
    credits.LB_CREDITS = {
      scroll: 0, maxScroll: 100, updateList: jest.fn(),
      mutate(fn: any) { fn({ clear: () => items.splice(0), add: (line: string) => items.push(line) }); },
    };
    state.MenuManager.MenuCredits = credits;
    state.MenuManager.GetMenuCredits = jest.fn(async () => credits);
    return { credits, items };
  }

  /** What GameState.Update does each frame for the open menus. */
  async function frames(seconds: number, step = 0.5) {
    for (let t = 0; t < seconds - 1e-9; t += step) {
      for (const menu of [...state.MenuManager.activeMenus]) menu.update(step);
      await flush();
    }
  }

  test('an ending script that waits for the credits gets to EndGame', async () => {
    const { credits } = creditsMenu();
    state.module = undefined;
    state.UnloadModule = jest.fn();
    state.NWScript = { Reload: jest.fn() };
    state.controls = { initKeys: jest.fn() };

    call(moduleRoutines.StartCreditSequence, {}, 0);
    // Same script, no frame in between: already in progress.
    expect(call(moduleRoutines.IsCreditSequenceInProgress, {})).toBe(1);
    await flush();
    expect(call(moduleRoutines.IsCreditSequenceInProgress, {})).toBe(1);
    expect(state.MenuManager.activeMenus).toEqual([credits]);

    // The ending script: poll until the crawl is over, then end the game.
    let polls = 0;
    while (call(moduleRoutines.IsCreditSequenceInProgress, {}) && polls < 1000) {
      await frames(1);
      polls++;
    }
    expect(polls).toBe(MenuCredits.MIN_DURATION);
    expect(state.MenuManager.activeMenus).toEqual([]);
    call(moduleRoutines.EndGame, {}, 0);
    await flush();
    expect(state.MenuManager.MainMenu.Start).toHaveBeenCalledTimes(1);
  });

  test('the crawl lists the credits 2DA lines, scrolls to the end and lasts per line', async () => {
    state.TwoDAManager.datatables.set('credits', { rows: { 0: { text: 'Producer' }, 1: { text: '****', strref: '42' }, 2: { text: '****', strref: '****' } } });
    state.TLKManager = { GetStringById: (id: number) => ({ Value: `tlk${id}` }) };
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    expect(MenuCredits.GetCreditLines()).toEqual(['Producer', 'tlk42']);

    const { credits, items } = creditsMenu();
    credits.startSequence(lines);
    expect(items).toEqual(lines);
    expect(credits.duration).toBe(30);
    await frames(15);
    expect(credits.LB_CREDITS.scroll).toBe(50);
    await frames(15);
    expect(credits.inProgress).toBe(false);
    expect(credits.LB_CREDITS.scroll).toBe(100);
  });

  test('skipping with Escape ends the sequence', async () => {
    const { credits } = creditsMenu();
    credits.startSequence([]);
    credits.close();
    expect(call(moduleRoutines.IsCreditSequenceInProgress, {})).toBe(0);
  });

  test('without a credits GUI it is in progress only until that is known', async () => {
    const { credits } = creditsMenu();
    credits.tGuiPanel = null;
    const started = GameOver.StartCreditSequence();
    expect(call(moduleRoutines.IsCreditSequenceInProgress, {})).toBe(1);
    expect(await started).toBe(false);
    expect(call(moduleRoutines.IsCreditSequenceInProgress, {})).toBe(0);
  });

  test('while the credits GUI is still being built for the first time, a poll already sees TRUE', async () => {
    const { credits } = creditsMenu();
    let finishBuild!: (menu: any) => void;
    state.MenuManager.MenuCredits = undefined;
    state.MenuManager.GetMenuCredits = jest.fn(() => new Promise((resolve) => { finishBuild = resolve; }));

    call(moduleRoutines.StartCreditSequence, {}, 0);
    await flush();
    expect(call(moduleRoutines.IsCreditSequenceInProgress, {})).toBe(1);

    state.MenuManager.MenuCredits = credits;
    finishBuild(credits);
    await flush();
    expect(credits.inProgress).toBe(true);
    expect(call(moduleRoutines.IsCreditSequenceInProgress, {})).toBe(1);
  });
});

describe('module item events', () => {
  function acquireRecorder(module: Module) {
    const seen: Array<{ item: any; from: any }> = [];
    module.scripts[ModuleObjectScript.ModuleOnPlayerAcquireItem] = stubScript((instance) => {
      seen.push({ item: call(GetModuleItemAcquired, instance), from: call(moduleRoutines.GetModuleItemAcquiredFrom, instance) });
    }).script;
    return seen;
  }

  function lossRecorder(module: Module) {
    const seen: Array<{ item: any; by: any }> = [];
    module.scripts[ModuleObjectScript.ModuleOnUnAcquireItem] = stubScript((instance) => {
      seen.push({ item: call(moduleRoutines.GetModuleItemLost, instance), by: call(moduleRoutines.GetModuleItemLostBy, instance) });
    }).script;
    return seen;
  }

  test('acquiring an item fires OnAcquireItem once, inside which GetModuleItemAcquired(From) are right', () => {
    const module = runningModule();
    const seen = acquireRecorder(module);
    PartyManager.party = [creature('pc')];
    const giver = creature('trader');
    const item = new FakeItem('g_w_blstrpstl001');

    const stored = InventoryManager.addItem(item as any, false, { acquiredFrom: giver });

    expect(stored).toBe(item);
    // Identity checks: a creature holds Three.js buffers jest cannot diff.
    expect(seen).toHaveLength(1);
    expect(seen[0].item === item).toBe(true);
    expect(seen[0].from === giver).toBe(true);
  });

  test('a module that is still loading fires nothing', () => {
    const module = runningModule();
    const seen = acquireRecorder(module);
    module.readyToProcessEvents = false;
    InventoryManager.addItem(new FakeItem('loading') as any);
    expect(seen).toHaveLength(0);
  });

  test('restoring a savegame inventory is not an acquisition', async () => {
    const module = runningModule();
    const seen = acquireRecorder(module);
    const inventory = new GFFObject();
    const entry = new GFFStruct();
    entry.addField(new GFFField(GFFDataType.CEXOSTRING, 'Tag')).setValue('g_a_class4001');
    inventory.RootNode.addField(new GFFField(GFFDataType.LIST, 'ItemList')).addChildStruct(entry);
    (GameFileSystem as any).readFile = jest.fn(async () => inventory.getExportBuffer());

    await (Object.create(SaveGame.prototype) as SaveGame).loadInventory();

    expect(InventoryManager.inventory.map((i: any) => i.tag)).toEqual(['g_a_class4001']);
    expect(seen).toHaveLength(0);
  });

  test('equipping and unequipping move items without OnUnAcquire / OnAcquire', () => {
    const module = runningModule();
    const acquired = acquireRecorder(module);
    const lost = lossRecorder(module);
    state.Module = { ModuleArea: { ModuleItem } };
    for (const name of ['initProperties', 'load', 'setStackSize'] as const) {
      jest.spyOn(ModuleItem.prototype, name as any).mockImplementation(() => {});
    }
    jest.spyOn(ModuleItem.prototype, 'getStackSize').mockReturnValue(1);
    jest.spyOn(ModuleItem.prototype, 'getBaseItemId').mockReturnValue(1);
    jest.spyOn(ModuleItem.prototype, 'isDisguise').mockReturnValue(false);
    const pc = creature('pc');
    jest.spyOn(pc, 'removeEffectsByCreator').mockImplementation(() => {});
    PartyManager.party = [pc];
    const armor = Object.create(ModuleItem.prototype) as ModuleItem;
    InventoryManager.inventory = [armor];

    armor.onEquip(pc);
    expect(InventoryManager.inventory).toHaveLength(0);
    armor.onUnEquip(pc);
    expect(InventoryManager.inventory).toHaveLength(1);

    expect(acquired).toHaveLength(0);
    expect(lost).toHaveLength(0);
  });

  test('losing an item fires OnUnAcquireItem with GetModuleItemLost / GetModuleItemLostBy (leader by default)', () => {
    const module = runningModule();
    const seen = lossRecorder(module);
    const pc = creature('pc');
    PartyManager.party = [pc];
    const item = new FakeItem('datapad');
    InventoryManager.inventory.push(item as any);

    InventoryManager.removeItem(item as any, 1);

    expect(seen).toHaveLength(1);
    expect(seen[0].item === item).toBe(true);
    expect(seen[0].by === pc).toBe(true);
    expect(InventoryManager.inventory).toHaveLength(0);
  });

  test('removing part of a stack reports the part that left, with its stack size', () => {
    const module = runningModule();
    const seen = lossRecorder(module);
    PartyManager.party = [creature('pc')];
    const medpacs = new FakeItem('g_i_medeqpmnt01', 5, true);
    InventoryManager.inventory.push(medpacs as any);

    InventoryManager.removeItem(medpacs as any, 2);

    expect(medpacs.getStackSize()).toBe(3);
    expect(seen).toHaveLength(1);
    expect(seen[0].item).not.toBe(medpacs);
    expect(seen[0].item.getTag()).toBe('g_i_medeqpmnt01');
    expect(seen[0].item.getStackSize()).toBe(2);
  });

  test('removal by tag fires the event too', () => {
    const module = runningModule();
    const seen = lossRecorder(module);
    PartyManager.party = [creature('pc')];
    const card = new FakeItem('k_keycard');
    InventoryManager.inventory.push(card as any);

    InventoryManager.removeItem('k_keycard', 1);

    expect(seen).toHaveLength(1);
    expect(seen[0].item === card).toBe(true);
  });

  /** An item action as the queue runs it; object parameters already resolved. */
  function act(ActionClass: any, owner: any, item: any, target: any) {
    const action = new ActionClass();
    action.owner = owner;
    action.parameters = [{ type: -1, value: item }, { type: -1, value: target }];
    return action.update(0);
  }

  function joinParty(...members: ModuleCreature[]) {
    for (const member of members) member.isPM = true;
    PartyManager.party = members;
  }

  test('ActionGiveItem: party to NPC is lost by the giver; NPC to party is acquired from the NPC; party to party fires nothing', () => {
    const module = runningModule();
    const lost = lossRecorder(module);
    const acquired = acquireRecorder(module);
    const pc = creature('pc');
    const mission = creature('mission');
    joinParty(pc, mission);
    const npc = creature('trask');
    const spice = new FakeItem('g_i_spice');
    InventoryManager.inventory.push(spice as any);

    expect(act(ActionGiveItem, mission, spice, npc)).toBe(ActionStatus.COMPLETE);
    expect(lost).toHaveLength(1);
    expect(lost[0].by === mission).toBe(true);
    expect(npc.inventory).toHaveLength(1);

    expect(act(ActionGiveItem, npc, npc.inventory[0], pc)).toBe(ActionStatus.COMPLETE);
    expect(acquired).toHaveLength(1);
    expect(acquired[0].from === npc).toBe(true);

    expect(act(ActionGiveItem, pc, InventoryManager.inventory[0], mission)).toBe(ActionStatus.COMPLETE);
    expect(lost).toHaveLength(1);
    expect(acquired).toHaveLength(1);
    expect(InventoryManager.inventory).toHaveLength(1);
  });

  test('ActionTakeItem by a party member reports the creature it came from; between party members nothing fires', () => {
    const module = runningModule();
    const lost = lossRecorder(module);
    const acquired = acquireRecorder(module);
    const pc = creature('pc');
    const carth = creature('carth');
    joinParty(pc, carth);
    const npc = creature('guard');
    const keycard = new FakeItem('k_keycard');
    npc.inventory = [keycard as any];

    expect(act(ActionTakeItem, pc, keycard, npc)).toBe(ActionStatus.COMPLETE);
    expect(acquired).toHaveLength(1);
    expect(acquired[0].from === npc).toBe(true);

    expect(act(ActionTakeItem, pc, InventoryManager.inventory[0], carth)).toBe(ActionStatus.COMPLETE);
    expect(acquired).toHaveLength(1);
    expect(lost).toHaveLength(0);
    expect(InventoryManager.inventory).toHaveLength(1);
  });

  test('looting a placeable moves each stack once and fires one acquire per stack', () => {
    const module = runningModule();
    const seen = acquireRecorder(module);
    const footlocker = Object.create(ModulePlaceable.prototype) as ModulePlaceable;
    footlocker.scripts = {} as any;
    const medpacs = new FakeItem('g_i_medeqpmnt01', 3, true);
    footlocker.inventory = [medpacs as any];

    footlocker.retrieveInventory();

    expect(InventoryManager.inventory).toEqual([medpacs]);
    expect(medpacs.getStackSize()).toBe(3);
    expect(seen).toHaveLength(1);
    expect(seen[0].from === footlocker).toBe(true);
  });

  test('looting a corpse reports the corpse', () => {
    const module = runningModule();
    const seen = acquireRecorder(module);
    const corpse = creature('sith_trooper');
    const rifle = new FakeItem('g_w_blstrrfl001');
    corpse.inventory = [rifle as any];

    corpse.retrieveInventory();

    expect(seen).toHaveLength(1);
    expect(seen[0].item === rifle).toBe(true);
    expect(seen[0].from === corpse).toBe(true);
  });

  test('buying from a store reports the store', () => {
    const module = runningModule();
    const seen = acquireRecorder(module);
    const pc = creature('pc');
    joinParty(pc);
    (PartyManager as any).Gold = 1000;
    jest.spyOn(PartyManager, 'AddGold').mockImplementation(() => {});
    const stock: any = Object.create(ModuleItem.prototype);
    stock.isInfinite = () => true;
    const bought = new FakeItem('g_i_medeqpmnt01');
    const store: any = { getInventory: () => [stock] };
    const menu: any = Object.create(MenuStore.prototype);
    menu.storeObject = store;
    menu.getSelectedTradeItem = () => stock;
    menu.merchantSellsToCustomer = () => true;
    menu.getItemBuyPrice = () => 10;
    menu.sanitizePurchasedItem = () => bought;
    menu.getCurrentTrader = () => pc;
    menu.refreshView = () => {};

    expect(menu.buySelectedItem()).toBe(true);

    expect(seen).toHaveLength(1);
    expect(seen[0].item === bought).toBe(true);
    expect(seen[0].from === store).toBe(true);
  });

  test('SignalEvent(GetModule(), EventActivateItem(...)) runs OnActvtItem with the GetItemActivated* values', () => {
    const module = runningModule();
    const seen: any[] = [];
    module.scripts[ModuleObjectScript.ModuleOnPlayerActivateItem] = stubScript((instance) => {
      seen.push([
        call(GetItemActivated, instance),
        call(GetItemActivator, instance),
        call(moduleRoutines.GetItemActivatedTarget, instance),
        call(moduleRoutines.GetItemActivatedTargetLocation, instance).position.toArray(),
      ]);
    }).script;
    const pc = creature('pc');
    const target = creature('droid');
    const item: any = new FakeItem('g_i_trapkit001');
    // Events carry object ids and resolve them on read, as in a save.
    const objects = new Map<number, any>([[101, pc], [102, target], [103, item]]);
    for (const [id, object] of objects) object.id = id;
    state.ModuleObjectManager.GetObjectById = (id: number) => objects.get(id);
    const caller = { caller: pc };

    const location = { position: { x: 1, y: 2, z: 3 } };
    const event = call(eventRoutines.EventActivateItemAction, caller, item, location, target);
    call(eventRoutines.SignalEvent, caller, call(moduleRoutines.GetModule, caller), event);

    expect(seen).toHaveLength(1);
    expect(seen[0][0] === item).toBe(true);
    expect(seen[0][1] === pc).toBe(true);
    expect(seen[0][2] === target).toBe(true);
    expect(seen[0][3]).toEqual([1, 2, 3]);
  });

  test('SignalEvent(GetModule(), EventUserDefined(n)) runs the module OnUserDefined with n', () => {
    const module = runningModule();
    const userDefined = stubScript();
    module.scripts[ModuleObjectScript.ModuleOnUserDefined] = userDefined.script;
    const areaHandler = jest.fn();
    (module.area as any).scriptEventHandler = areaHandler;

    call(eventRoutines.SignalEvent, {}, module, call(eventRoutines.EventUserDefinedAction, {}, 4002));

    expect(userDefined.runs.map((run) => run.scriptVar)).toEqual([4002]);
    expect(areaHandler).not.toHaveBeenCalled();
  });

  test('SignalEvent(GetModule(), <other event>) still reaches the area, as before', () => {
    const module = runningModule();
    const areaHandler = jest.fn();
    (module.area as any).scriptEventHandler = areaHandler;
    const event = call(eventRoutines.EventSpellCastAtAction, {}, undefined, 5, 1);

    call(eventRoutines.SignalEvent, {}, module, event);

    expect(areaHandler).toHaveBeenCalledWith(event);
  });
});

describe('module heartbeat', () => {
  test('Mod_OnHeartbeat fires every 6 s of game time', () => {
    const module = runningModule();
    const heartbeat = stubScript();
    module.scripts[ModuleObjectScript.ModuleOnHeartbeat] = heartbeat.script;

    tickFor(module, 5.75);
    expect(heartbeat.runs).toHaveLength(0);
    tickFor(module, 0.25);
    expect(heartbeat.runs).toHaveLength(1);
    tickFor(module, 12);
    expect(heartbeat.runs).toHaveLength(3);

    module.readyToProcessEvents = false;
    tickFor(module, 12);
    expect(heartbeat.runs).toHaveLength(3);
  });

  test('a long hitch gives one beat and keeps the phase', () => {
    const module = runningModule();
    const heartbeat = stubScript();
    module.scripts[ModuleObjectScript.ModuleOnHeartbeat] = heartbeat.script;

    module.tick(13);
    expect(heartbeat.runs).toHaveLength(1);
    module.tick(0.5);
    expect(heartbeat.runs).toHaveLength(1);
    module.tick(4.5);
    expect(heartbeat.runs).toHaveLength(2);
  });

  test('a module script that throws does not take the tick down', () => {
    const module = runningModule();
    module.scripts[ModuleObjectScript.ModuleOnHeartbeat] = stubScript(() => { throw new Error('bad ncs'); }).script;
    const pc = creature('pc');
    const carth = creature('carth');
    PartyManager.party = [pc, carth];
    kill(pc);

    expect(() => module.tick(6)).not.toThrow();
    expect(PartyManager.party[0]).toBe(carth);
  });
});

describe('module locals and tokens survive the IFO save/load', () => {
  function baseIFO(): GFFObject {
    const ifo = new GFFObject();
    const root = ifo.RootNode;
    const area = new GFFStruct();
    area.addField(new GFFField(GFFDataType.RESREF, 'Area_Name')).setValue('end_m01aa');
    root.addField(new GFFField(GFFDataType.LIST, 'Mod_Area_list')).addChildStruct(area);
    for (const label of ['Mod_Creator_ID', 'Mod_Entry_Dir_X', 'Mod_Entry_Dir_Y', 'Mod_Entry_X', 'Mod_Entry_Y',
      'Mod_Entry_Z', 'Mod_Version', 'Mod_XPScale']) {
      root.addField(new GFFField(GFFDataType.INT, label)).setValue(0);
    }
    root.addField(new GFFField(GFFDataType.CEXOLOCSTRING, 'Mod_Description'));
    root.addField(new GFFField(GFFDataType.CEXOLOCSTRING, 'Mod_Name'));
    root.addField(new GFFField(GFFDataType.RESREF, 'Mod_Entry_Area')).setValue('end_m01aa');
    root.addField(new GFFField(GFFDataType.CEXOSTRING, 'Mod_Hak')).setValue('');
    root.addField(new GFFField(GFFDataType.VOID, 'Mod_ID')).setValue(new Uint8Array(16));
    root.addField(new GFFField(GFFDataType.CEXOSTRING, 'Mod_Tag')).setValue('END_M01AA');
    for (const label of Object.values(ModuleObjectScript).filter((key) => key.startsWith('Mod_'))) {
      root.addField(new GFFField(GFFDataType.RESREF, label)).setValue('');
    }
    return ifo;
  }

  async function saveAndReload(module: Module): Promise<Module> {
    module.area = { saveAreaListStruct: () => baseIFO().getFieldByLabel('Mod_Area_list').getChildStructs()[0], save: jest.fn() } as any;
    module.filename = 'end_m01aa';
    state.TwoDAManager.datatables.set('modulesave', { getRowByColumnAndValue: () => ({ includeInSave: '0' }) });
    state.PartyManager = { Save: jest.fn(), ExportPartyMemberTemplates: jest.fn(async () => {}), party: [] };
    state.InventoryManager = { Save: jest.fn(async () => {}) };
    await module.save(true);
    const reloaded = new Module();
    reloaded.setFromIFO(new GFFObject(module.ifo.getExportBuffer()), true);
    state.module = reloaded;
    return reloaded;
  }

  test('SetLocalBoolean/SetLocalNumber on GetModule() and custom tokens round-trip a save', async () => {
    const module = new Module();
    module.setFromIFO(baseIFO(), false);
    state.module = module;
    const self = {};
    const oModule = call(moduleRoutines.GetModule, self);
    call(localVarRoutines.SetLocalBoolean, self, oModule, 0, 1);
    call(localVarRoutines.SetLocalBoolean, self, oModule, 31, 1);
    call(localVarRoutines.SetLocalBoolean, self, oModule, 70, 1);
    call(localVarRoutines.SetLocalNumber, self, oModule, 3, 42);
    module.setCustomToken(51, 'Revan');

    await saveAndReload(module);
    const oReloaded = call(moduleRoutines.GetModule, self);

    expect([0, 1, 31, 70].map((i) => call(localVarRoutines.GetLocalBoolean, self, oReloaded, i))).toEqual([1, 0, 1, 1]);
    expect(call(localVarRoutines.GetLocalNumber, self, oReloaded, 3)).toBe(42);
    expect(call(localVarRoutines.GetLocalNumber, self, oReloaded, 4)).toBe(0);
    expect(state.module.getCustomToken(51)).toBe('Revan');
  });

  test('designer-range locals (number 12, boolean 100) survive a save; the table grows only to the highest index set', async () => {
    const module = new Module();
    module.setFromIFO(baseIFO(), false);
    state.module = module;
    const self = { caller: module };
    call(localVarRoutines.SetLocalNumber, self, module, 12, 5);
    call(localVarRoutines.SetLocalNumber, self, module, 255, 9);
    call(localVarRoutines.SetLocalBoolean, self, module, 100, 1);
    call(localVarRoutines.SetLocalBoolean, self, module, 1023, 1);
    module.setLocalNumber(5, 300);

    const table = module.getSWVarTableSaveStruct();
    expect(table.getFieldByLabel('BitArray').getChildStructs()).toHaveLength(32);
    expect(table.getFieldByLabel('ByteArray').getChildStructs()).toHaveLength(256);

    const reloaded = await saveAndReload(module);

    expect(call(localVarRoutines.GetLocalNumber, self, reloaded, 12)).toBe(5);
    expect(call(localVarRoutines.GetLocalNumber, self, reloaded, 255)).toBe(9);
    expect(call(localVarRoutines.GetLocalBoolean, self, reloaded, 100)).toBe(1);
    expect(call(localVarRoutines.GetLocalBoolean, self, reloaded, 1023)).toBe(1);
    expect(call(localVarRoutines.GetLocalBoolean, self, reloaded, 99)).toBe(0);
    expect(reloaded.getLocalNumber(5)).toBe(300 & 0xFF);
  });

  test('a module with only low locals keeps the 3 + 8 layout; indices past the bounds are ignored with a warning', () => {
    const module = new Module();
    const warn = console.warn as jest.Mock;
    module.setLocalNumber(13, 0);
    module.setLocalBoolean(2, true);
    module.setLocalNumber(256, 7);
    module.setLocalNumber(100000, 5);
    module.setLocalNumber(-1, 5);
    module.setLocalBoolean(1024, true);
    module.setLocalBoolean(1e6, true);

    expect(warn.mock.calls.filter((args) => String(args[0]).includes('Module: local'))).toHaveLength(5);
    const table = module.getSWVarTableSaveStruct();
    expect(table.getFieldByLabel('BitArray').getChildStructs()).toHaveLength(3);
    // A zero at index 13 needs no entry: an absent number reads back as 0.
    expect(table.getFieldByLabel('ByteArray').getChildStructs()).toHaveLength(8);
  });

  test('a creature number local at index 12 survives its own save/load (object SWVarTable)', () => {
    jest.spyOn(ModuleCreature.prototype, 'loadScripts').mockImplementation(() => {});
    const npc = creature('trask');
    npc.setLocalNumber(12, 3);
    npc.setLocalBoolean(70, true);

    const saved = npc.save();
    const restored = new ModuleCreature(new GFFObject(saved.getExportBuffer()));
    restored.load();

    expect(restored.getLocalNumber(12)).toBe(3);
    expect(restored.getLocalBoolean(70)).toBe(true);
  });

  test('a stray huge index on an object local does not grow its save past the bounds', () => {
    const npc = creature('trask');
    npc.setLocalNumber(100000, 1);
    npc.setLocalBoolean(1e6, true);

    const table = npc.getSWVarTableSaveStruct();

    expect(table.getFieldByLabel('BitArray').getChildStructs()).toHaveLength(3);
    expect(table.getFieldByLabel('ByteArray').getChildStructs()).toHaveLength(8);
  });

  test('loading an IFO replaces the previous module locals', () => {
    const module = new Module();
    module.setFromIFO(baseIFO(), false);
    module.setLocalBoolean(4, true);
    module.setLocalNumber(2, 9);

    module.setFromIFO(baseIFO(), true);

    expect(module.getLocalBoolean(4)).toBe(false);
    expect(module.getLocalNumber(2)).toBe(0);
  });

  test('locals on an invalid object are ignored rather than throwing', () => {
    state.module = new Module();
    expect(() => call(localVarRoutines.SetLocalNumber, {}, undefined, 1, 5)).not.toThrow();
    expect(call(localVarRoutines.GetLocalBoolean, {}, undefined, 1)).toBe(0);
  });
});

describe('Mod_* scripts run as the module (OBJECT_SELF == GetModule())', () => {
  test('a module event script setting a local on OBJECT_SELF is readable through GetModule()', () => {
    const module = runningModule();
    const seen: any = {};
    module.scripts[ModuleObjectScript.ModuleOnHeartbeat] = stubScript((instance) => {
      seen.selfIsModule = instance.caller === call(moduleRoutines.GetModule, instance);
      call(localVarRoutines.SetLocalNumber, instance, instance.caller, 3, 9);
      call(localVarRoutines.SetLocalBoolean, instance, instance.caller, 40, 1);
    }).script;

    tickFor(module, 6);

    expect(seen.selfIsModule).toBe(true);
    const oModule = call(moduleRoutines.GetModule, {});
    expect(call(localVarRoutines.GetLocalNumber, {}, oModule, 3)).toBe(9);
    expect(call(localVarRoutines.GetLocalBoolean, {}, oModule, 40)).toBe(1);
  });

  test('a throwing OnModLoad does not reject the module load, and OnClientEnter still runs', async () => {
    const module = runningModule();
    const onLoad = stubScript(() => { throw new TypeError("Cannot read properties of undefined (reading 'filter')"); });
    const onEnter = stubScript();
    module.scriptResRefs.set(ModuleObjectScript.ModuleOnLoad, 'k_mod_load');
    module.scriptResRefs.set(ModuleObjectScript.ModuleOnPlayerClientEnter, 'k_mod_enter');
    state.NWScript = { Load: (resref: string) => ({ k_mod_load: onLoad, k_mod_enter: onEnter } as any)[resref]?.script.newInstance() };

    await expect(module.initScripts()).resolves.toBeUndefined();
    expect(onLoad.runs).toHaveLength(1);
    expect(onEnter.runs).toHaveLength(1);
  });

  test('OnModLoad and OnClientEnter run as the module too', async () => {
    const module = runningModule();
    const onLoad = stubScript();
    const onEnter = stubScript();
    module.scriptResRefs.set(ModuleObjectScript.ModuleOnLoad, 'k_mod_load');
    module.scriptResRefs.set(ModuleObjectScript.ModuleOnPlayerClientEnter, 'k_mod_enter');
    state.NWScript = { Load: (resref: string) => ({ k_mod_load: onLoad, k_mod_enter: onEnter } as any)[resref]?.script.newInstance() };
    const pc = creature('pc');
    PartyManager.party = [pc];

    await module.initScripts();

    expect(onLoad.runs.map((run) => run.caller === module)).toEqual([true]);
    expect(onEnter.runs.map((run) => run.caller === module)).toEqual([true]);
    expect(onEnter.runs[0].instance.enteringObject === pc).toBe(true);
  });

  test('DelayCommand from a module script fires, still as the module', () => {
    const module = runningModule();
    module.timeManager = new ModuleTimeManager();
    module.timeManager.enabled = true;
    state.GameEventFactory = { EventTimedEvent };
    const fired: any[] = [];
    const delayed: any = {
      setCaller(caller: any) { this.caller = caller; },
      seekTo() {},
      runScript() { fired.push(this.caller); },
    };
    module.scripts[ModuleObjectScript.ModuleOnHeartbeat] = stubScript((instance) => {
      if (fired.length || module.eventQueue.length) return;
      call(scriptingRoutines.DelayCommand, instance, 2.0, { script: delayed, offset: 12 });
    }).script;

    tickFor(module, 6);
    expect(module.eventQueue).toHaveLength(1);
    expect(fired).toHaveLength(0);
    tickFor(module, 1.5);
    expect(fired).toHaveLength(0);
    tickFor(module, 1);

    expect(fired).toHaveLength(1);
    expect(fired[0] === module).toBe(true);
  });

  test('a saved event owned by the module resolves back to it by id', () => {
    const module = runningModule();
    state.ModuleObjectManager.GetObjectById = (id: number) => ModuleObjectManager.GetObjectById(id);
    const event = new EventTimedEvent();
    event.setCaller(module as any);
    expect(event.callerId).toBe(ModuleObjectConstant.MODULE_ID);

    const restored = new EventTimedEvent();
    restored.setCallerId(event.callerId);
    expect(restored.getCaller() === (module as any)).toBe(true);
    expect(ModuleObjectManager.GetObjectById(ModuleObjectConstant.OBJECT_INVALID)).toBeUndefined();
  });

  test('AssignCommand(GetModule(), ...) runs the command as the module', () => {
    const module = runningModule();
    const ran: any[] = [];
    const action = { script: { seekTo() {}, runScript() { ran.push(this.caller); }, caller: undefined as any }, offset: 0 };

    call(scriptingRoutines.AssignCommand, {}, call(moduleRoutines.GetModule, {}), action);

    expect(ran).toHaveLength(1);
    expect(ran[0] === module).toBe(true);
  });

  test('GetArea / GetPosition of OBJECT_SELF in a module script: OBJECT_INVALID and the origin (the module is not in an area)', () => {
    const module = runningModule();
    const seen: any = {};
    module.scripts[ModuleObjectScript.ModuleOnHeartbeat] = stubScript((instance) => {
      seen.self = instance.caller;
      seen.area = call(queryRoutines.GetArea, instance, instance.caller);
      seen.position = call(queryRoutines.GetPosition, instance, instance.caller);
    }).script;

    tickFor(module, 6);

    expect(seen.self === module).toBe(true);
    expect(seen.area).toBeUndefined();
    expect(seen.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  test('creature-only routines called as the module do nothing instead of aborting the script', () => {
    const module = runningModule();
    const self = { caller: module, delayCommands: [] as any[] };
    state.ActionFactory = { ActionGiveItem: class { setParameter() {} } };
    expect(() => {
      call(movementRoutines.SetFacing, self, 90);
      call(scriptingRoutines.ActionDoCommand, self, { script: {}, offset: 0 });
      // An Action* routine that queues on the caller without checking it.
      call(itemsLegacyRoutines.ActionGiveItem, self, new FakeItem('g_i_credits001'), creature('pc'));
    }).not.toThrow();
    expect(call(combatRoutines.GetAttemptedAttackTarget, self)).toBeUndefined();
    expect(call(combatRoutines.GetAttemptedSpellTarget, self)).toBeUndefined();
    expect(call(objectCombatRoutines.GetLastHostileTarget, self)).toBeUndefined();
    expect(call(perceptionRoutines.GetBlockingDoor, self)).toBeUndefined();
  });

  test('attacks made as the module (ActionAttack, DoDoorAction bash, CutsceneAttack) do nothing', () => {
    const module = runningModule();
    const self = { caller: module };
    const victim = creature('sith');
    const door: any = { objectType: ModuleObjectType.ModuleObject | ModuleObjectType.ModuleDoor };
    state.TwoDAManager.datatables.set('animations', { rows: { 5: { name: 'attack' } } });
    expect(() => call(combatRoutines.ActionAttack, self, victim, 0)).not.toThrow();
    expect(() => call(doorRoutines.DoDoorAction, self, door, 2)).not.toThrow();
    expect(() => call(objectCombatRoutines.CutsceneAttack, self, victim, 5, 1, 3)).not.toThrow();
  });

  test('routines that queue on the caller do nothing when it is gone (a destroyed DelayCommand owner)', () => {
    const self = { caller: undefined as any };
    const action = class { setParameter() {} };
    state.ActionFactory = { ActionUnlockObject: action, ActionLockObject: action, ActionGiveItem: action, ActionTakeItem: action, ActionEquipItem: action };
    const door: any = { objectType: ModuleObjectType.ModuleObject | ModuleObjectType.ModuleDoor };
    const npc = creature('trask');
    const sword: any = new FakeItem('g_w_lghtsbr01');
    sword.baseItem = { weaponWield: 4, dieToRoll: 8, numDice: 2 };
    npc.inventory = [sword];
    npc.equipment = {} as any;
    expect(() => {
      call(doorRoutines.ActionUnlockObject, self, door);
      call(doorRoutines.ActionLockObject, self, door);
      call(itemsLegacyRoutines.ActionGiveItem, self, new FakeItem('a'), npc);
      call(itemsLegacyRoutines.ActionTakeItem, self, new FakeItem('a'), npc);
      call(scriptingRoutines.ActionDoCommand, self, { script: {}, offset: 0 });
      call(equipmentRoutines.ActionEquipMostDamagingMelee, self, npc, 0);
      call(equipmentRoutines.ActionEquipMostDamagingRanged, self, npc);
    }).not.toThrow();
  });

  test('nearest-object queries relative to the module are OBJECT_INVALID, not a crash', () => {
    const module = runningModule();
    const a = creature('a');
    const b = creature('b');
    (module.area as any).creatures = [a, b];
    (module.area as any).placeables = [];
    ModuleObjectManager.module = module;
    state.ModuleObjectManager.GetNearestCreature = ModuleObjectManager.GetNearestCreature.bind(ModuleObjectManager);
    state.ModuleObjectManager.GetNearestObject = ModuleObjectManager.GetNearestObject.bind(ModuleObjectManager);
    const self = { caller: module };

    // CREATURE_TYPE_PERCEPTION / PERCEPTION_SEEN_AND_HEARD reads the target's perception list.
    expect(call(miscLegacyRoutines.GetNearestCreature, self, 7, 0, module, 1, -1, -1, -1, -1)).toBeUndefined();
    expect(call(queryRoutines.GetNearestObject, self, 1, module, 1)).toBeUndefined();
    expect(call(queryRoutines.GetNearestObjectByTag, self, 'a', module, 1)).toBeUndefined();
  });

  test('GetIsObjectValid(GetModule()) / (OBJECT_SELF) is TRUE and GetTag(GetModule()) is the module tag', () => {
    const module = runningModule();
    module.tag = 'END_M01AA';
    module.filename = 'end_m01aa';
    const seen: any = {};
    module.scripts[ModuleObjectScript.ModuleOnHeartbeat] = stubScript((instance) => {
      seen.self = call(queryRoutines.GetIsObjectValid, instance, instance.caller);
      seen.module = call(queryRoutines.GetIsObjectValid, instance, call(moduleRoutines.GetModule, instance));
      seen.tag = call(queryRoutines.GetTag, instance, call(moduleRoutines.GetModule, instance));
    }).script;

    tickFor(module, 6);

    expect(seen).toEqual({ self: 1, module: 1, tag: 'END_M01AA' });
    module.tag = '';
    expect(call(queryRoutines.GetTag, {}, module)).toBe('end_m01aa');
    expect(call(queryRoutines.GetIsObjectValid, {}, undefined)).toBe(0);
  });
});

describe('death screen message and revive without an area', () => {
  function messageLabel(menu: any, initial = 'You have been defeated.') {
    let text = initial;
    menu.LBL_MESSAGE = { getText: () => text, setText: (value: string) => { text = value; } };
    return () => text;
  }

  test('PopUpDeathGUIPanel shows sHelpString, else the TLK string; a later plain death restores the GUI text', async () => {
    runningModule();
    state.TLKManager = { GetStringById: (id: number) => ({ Value: `tlk ${id}` }) };
    await state.MenuManager.GetMenuGameOver();
    const text = messageLabel(state.MenuManager.MenuGameOver);

    call(moduleRoutines.PopUpDeathGUIPanel, {}, undefined, 0, 0, 0, 'The Sith overwhelmed you.');
    await flush();
    expect(text()).toBe('The Sith overwhelmed you.');

    call(moduleRoutines.PopUpDeathGUIPanel, {}, undefined, 0, 0, 42213, '');
    await flush();
    expect(text()).toBe('tlk 42213');

    // A re-open (monitor) keeps the text; an engine-default death restores the GUI's.
    await GameOver.OpenDeathScreen();
    expect(text()).toBe('tlk 42213');
    await GameOver.OpenDeathScreen('');
    expect(text()).toBe('You have been defeated.');
  });

  test('an engine-default death after a scripted one does not show the old reason', async () => {
    const module = runningModule();
    await state.MenuManager.GetMenuGameOver();
    const text = messageLabel(state.MenuManager.MenuGameOver);
    const pc = creature('pc');
    PartyManager.party = [pc];
    module.scripts[ModuleObjectScript.ModuleOnPlayerDeath] = stubScript((instance) => {
      call(moduleRoutines.PopUpDeathGUIPanel, instance, pc, 0, 0, 0, 'Killed by the rancor.');
    }).script;
    kill(pc);
    module.tick(0.1);
    await flush();
    expect(text()).toBe('Killed by the rancor.');

    // Loaded back up; this time the module has no death script.
    state.MenuManager.MenuGameOver.close();
    pc.currentHitPoints = 10;
    module.tick(0.1);
    delete module.scripts[ModuleObjectScript.ModuleOnPlayerDeath];
    kill(pc);
    module.tick(0.1);
    await flush();
    expect(text()).toBe('You have been defeated.');
  });

  test('with no area to check for hostiles, nobody is revived', () => {
    const module = runningModule();
    const pc = creature('pc');
    const carth = creature('carth');
    PartyManager.party = [pc, carth];
    module.area = undefined;

    kill(carth);
    tickFor(module, 10);

    expect(carth.isDead()).toBe(true);
  });
});

describe('the module-caller guards do not shut out placeable, door and trigger scripts', () => {
  function placeableSelf() {
    const placeable: any = new ModulePlaceable(new GFFObject());
    const queued: any[] = [];
    placeable.actionQueue = { add: (action: any) => queued.push(action), addFront: (action: any) => queued.push(action) };
    placeable.doCommand = jest.fn();
    placeable.setFacing = jest.fn();
    return { placeable, queued };
  }

  test('a placeable running Action* routines still queues on itself and can face', () => {
    runningModule();
    const { placeable, queued } = placeableSelf();
    const self = { caller: placeable };
    const action = class { setParameter() {} };
    state.ActionFactory = { ActionUnlockObject: action, ActionLockObject: action, ActionGiveItem: action, ActionTakeItem: action };
    const door: any = { objectType: ModuleObjectType.ModuleObject | ModuleObjectType.ModuleDoor };
    const pc = creature('pc');

    call(itemsLegacyRoutines.ActionGiveItem, self, new FakeItem('x'), pc);
    call(itemsLegacyRoutines.ActionTakeItem, self, new FakeItem('x'), pc);
    call(doorRoutines.ActionUnlockObject, self, door);
    call(doorRoutines.ActionLockObject, self, door);
    expect(queued).toHaveLength(4);
    call(scriptingRoutines.ActionDoCommand, self, { script: {}, offset: 0 });
    expect(placeable.doCommand).toHaveBeenCalledTimes(1);
    call(movementRoutines.SetFacing, self, 90);
    expect(placeable.setFacing).toHaveBeenCalledWith(90);
  });

  test('nearest queries relative to a placeable or trigger still run', () => {
    runningModule();
    const { placeable } = placeableSelf();
    const trigger: any = { objectType: ModuleObjectType.ModuleObject | ModuleObjectType.ModuleTrigger };
    const found: any = { tag: 'found' };
    state.ModuleObjectManager.GetNearestObject = jest.fn(() => found);
    state.ModuleObjectManager.GetNearestObjectByTag = jest.fn(() => found);
    state.ModuleObjectManager.GetNearestCreature = jest.fn(() => found);
    const self = { caller: placeable };

    expect(call(queryRoutines.GetNearestObject, self, 1, placeable, 1)).toBe(found);
    expect(call(queryRoutines.GetNearestObjectByTag, self, 'a', trigger, 1)).toBe(found);
    expect(call(miscLegacyRoutines.GetNearestCreature, self, 7, 0, trigger, 1, -1, -1, -1, -1)).toBe(found);
  });
});
