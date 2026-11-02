import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

/**
 * Module-level script events and the party death flow, executed for real.
 *
 * Before this suite Module loaded Mod_OnPlrDeath / Mod_OnAcquirItem / Mod_OnHeartbeat
 * / Mod_OnUsrDefined and friends but only ever ran OnModLoad and OnClientEnter;
 * a dead party leader kept control of a corpse and a wiped party stood there
 * forever; PopUpDeathGUIPanel, GetModuleItemAcquiredFrom, GetModuleItemLost* and
 * GetItemActivated* were diagnostic stubs; SetLocal* on GetModule() threw and the
 * module's SWVarTable and Mod_Tokens were saved empty.
 *
 * Drives the real Module, PartyDeathMonitor, PartyManager, InventoryManager,
 * ModuleCreature, ModulePlaceable, the MenuGameOver classes and the NWScript
 * routine bodies (through buildRuntimeAction, i.e. with the VM's argument
 * inflation). Module scripts are stand-ins whose run() calls those routines,
 * which is what a compiled .ncs would do.
 */

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/utility/GameFileSystem', () => ({ GameFileSystem: {} }));
jest.mock('@/engine/CurrentGame', () => ({ CurrentGame: { WriteFile: jest.fn(), gameinprogress_dir: '/nonexistent' } }));
jest.mock('@/loaders/ResourceLoader', () => ({ ResourceLoader: {} }));
jest.mock('@/loaders', () => ({ MDLLoader: {}, ResourceLoader: {}, TextureLoader: { textures: new Map() } }));
jest.mock('@/odyssey', () => ({
  OdysseyModel: class {}, OdysseyModelAnimation: class {}, OdysseyWalkMesh: class {},
}));
jest.mock('@/three/odyssey', () => {
  const THREE = jest.requireActual('three') as typeof import('three');
  return {
    OdysseyModel3D: class {}, OdysseyObject3D: class extends THREE.Object3D {}, OdysseyLightsaberEffect: class {},
  };
});
jest.mock('@/engine/TextSprite3D', () => {
  const THREE = jest.requireActual('three') as typeof import('three');
  return { TextSprite3D: class { container = new THREE.Object3D(); setColor() {} } };
});
jest.mock('@/module/ModuleArea', () => ({ ModuleArea: class {} }));
jest.mock('@/nwscript/NWScript', () => ({ NWScript: class {} }));
jest.mock('@/nwscript/NWScriptInstance', () => ({ NWScriptInstance: class {} }));
jest.mock('@/engine/CollisionManager', () => ({ CollisionManager: class {} }));
jest.mock('@/combat', () => ({ CombatRound: class {}, CombatRoundAction: class {} }));
// The GUI layer is browser-only; GameMenu is reduced to the fields the menus read.
jest.mock('@/gui', () => ({ GameMenu: class { tGuiPanel: any; selectedControl: any; gui_resref = ''; background = ''; voidFill = false; async menuControlInitializer() {} } }));

import { GameState } from '@/GameState';
import { Module } from '@/module/Module';
import { PartyDeathMonitor } from '@/module/PartyDeathMonitor';
import { ModuleCreature } from '@/module/ModuleCreature';
import { ModulePlaceable } from '@/module/ModulePlaceable';
import { PartyManager } from '@/managers/PartyManager';
import { InventoryManager } from '@/managers/InventoryManager';
import { GameOver } from '@/engine/GameOver';
import { MenuGameOver as K1MenuGameOver } from '@/game/kotor/menu/MenuGameOver';
import { MenuGameOver as TSLMenuGameOver } from '@/game/tsl/menu/MenuGameOver';
import { buildRuntimeAction } from '@/nwscript/builtins/actionBuilder';
import * as moduleRoutines from '@/nwscript/builtins/objects/module';
import * as localVarRoutines from '@/nwscript/builtins/localvars';
import * as eventRoutines from '@/nwscript/builtins/events';
import { GetItemActivated, GetItemActivator } from '@/nwscript/builtins/missing';
import { GetModuleItemAcquired } from '@/nwscript/builtins/upstream/inventory';
import { ModuleObjectScript } from '@/enums/module/ModuleObjectScript';
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
        run(caller: any, scriptVar = 0) {
          runs.push({ caller, scriptVar, instance });
          onRun(instance, scriptVar);
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
  module.area = { update: jest.fn(), updatePaused: jest.fn() } as any;
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
  stack: number;
  constructor(public tag: string, stack = 1, public stackable = false) { this.stack = stack; }
  initProperties() {}
  load() {}
  getStackSize() { return this.stack; }
  setStackSize(n: number) { this.stack = n; }
  getBaseItemId() { return 1; }
  getTag() { return this.tag; }
  canStackWith(other: any) { return this.stackable && other instanceof FakeItem && other.tag === this.tag; }
}

let deathMenu: { tGuiPanel: any; open: jest.Mock };

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
  state.FactionManager = { factions: new Map(), AddCreatureToFaction: jest.fn(), Export: jest.fn(async () => {}) };
  state.AppearanceManager = { GetCreatureAppearanceById: (): undefined => undefined };
  state.ActionFactory = { FromStruct: jest.fn(() => undefined) };
  state.TwoDAManager = { datatables: new Map() };
  state.GetDebugState = () => false;

  deathMenu = { tGuiPanel: {}, open: jest.fn() };
  state.MenuManager = {
    activeMenus: [] as any[],
    GetMenuGameOver: jest.fn(async () => deathMenu),
    MenuSaveLoad: { mode: undefined as any, open: jest.fn() },
    MainMenu: { Start: jest.fn() },
  };
  GameOver.creditsInProgress = false;

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
    expect(deathMenu.open).not.toHaveBeenCalled();
  });

  test('the whole party down: OnPlrDeath runs exactly once and PopUpDeathGUIPanel opens the death menu', async () => {
    const module = runningModule();
    let lastDied: any;
    const death = stubScript((instance) => {
      lastDied = call(moduleRoutines.GetLastPlayerDied, instance);
      call(moduleRoutines.PopUpDeathGUIPanel, instance, PartyManager.party[0], 0, 0, 0, '');
    });
    const dying = stubScript();
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
    expect(death.runs[0].caller).toBe(module.area);
    expect(lastDied).toBe(pc);
    expect(deathMenu.open).toHaveBeenCalledTimes(1);
  });

  test('a module without an OnPlrDeath script still gets the death menu, once', async () => {
    const module = runningModule();
    const pc = creature('pc');
    PartyManager.party = [pc];

    kill(pc);
    tickFor(module, 5);
    await flush();

    expect(state.MenuManager.GetMenuGameOver).toHaveBeenCalledTimes(1);
    expect(deathMenu.open).toHaveBeenCalledTimes(1);
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

  test('the death screen falls back to the load menu when the game over GUI is missing', async () => {
    deathMenu.tGuiPanel = null;
    expect(await GameOver.OpenDeathScreen()).toBe(false);
    expect(deathMenu.open).not.toHaveBeenCalled();
    expect(state.MenuManager.MenuSaveLoad.mode).toBe(MenuSaveLoadMode.LOADGAME);
    expect(state.MenuManager.MenuSaveLoad.open).toHaveBeenCalledTimes(1);
  });

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

  test('EndGame returns to the main menu', () => {
    state.module = undefined;
    state.UnloadModule = jest.fn();
    state.NWScript = { Reload: jest.fn() };
    state.controls = { initKeys: jest.fn() };
    call(moduleRoutines.EndGame, {}, 0);
    expect(state.MenuManager.MainMenu.Start).toHaveBeenCalledTimes(1);
  });

  test('StartCreditSequence opens the credits and IsCreditSequenceInProgress tracks them', async () => {
    const credits: any = { tGuiPanel: {}, open: jest.fn(() => state.MenuManager.activeMenus.push(credits)) };
    state.MenuManager.GetMenuCredits = jest.fn(async () => credits);
    state.MenuManager.MenuCredits = credits;
    expect(call(moduleRoutines.IsCreditSequenceInProgress, {})).toBe(0);
    call(moduleRoutines.StartCreditSequence, {}, 0);
    await flush();
    expect(credits.open).toHaveBeenCalledTimes(1);
    expect(call(moduleRoutines.IsCreditSequenceInProgress, {})).toBe(1);
  });
});

describe('module item events', () => {
  test('acquiring an item fires OnAcquireItem once, inside which GetModuleItemAcquired(From) are right', () => {
    const module = runningModule();
    const seen: any[] = [];
    const onAcquire = stubScript((instance) => {
      seen.push([call(GetModuleItemAcquired, instance), call(moduleRoutines.GetModuleItemAcquiredFrom, instance)]);
    });
    module.scripts[ModuleObjectScript.ModuleOnPlayerAcquireItem] = onAcquire.script;
    const pc = creature('pc');
    const giver = creature('trader');
    PartyManager.party = [pc];
    const item = new FakeItem('g_w_blstrpstl001');

    const stored = InventoryManager.addItem(item as any, false, { acquiredFrom: giver });

    expect(stored).toBe(item);
    expect(onAcquire.runs).toHaveLength(1);
    // Identity checks: a creature holds Three.js buffers jest cannot diff.
    expect(seen).toHaveLength(1);
    expect(seen[0][0] === item).toBe(true);
    expect(seen[0][1] === giver).toBe(true);
  });

  test('restoring a savegame inventory, unequipping and a module that is still loading fire nothing', () => {
    const module = runningModule();
    const onAcquire = stubScript();
    const onLose = stubScript();
    module.scripts[ModuleObjectScript.ModuleOnPlayerAcquireItem] = onAcquire.script;
    module.scripts[ModuleObjectScript.ModuleOnUnAcquireItem] = onLose.script;

    const equipped = new FakeItem('armor');
    InventoryManager.addItem(equipped as any, false, { silent: true });
    InventoryManager.removeItem(equipped as any, 1, { silent: true });
    module.readyToProcessEvents = false;
    InventoryManager.addItem(new FakeItem('loading') as any);

    expect(onAcquire.runs).toHaveLength(0);
    expect(onLose.runs).toHaveLength(0);
  });

  test('losing an item fires OnUnAcquireItem with GetModuleItemLost / GetModuleItemLostBy', () => {
    const module = runningModule();
    const seen: any[] = [];
    module.scripts[ModuleObjectScript.ModuleOnUnAcquireItem] = stubScript((instance) => {
      seen.push([call(moduleRoutines.GetModuleItemLost, instance), call(moduleRoutines.GetModuleItemLostBy, instance)]);
    }).script;
    const pc = creature('pc');
    PartyManager.party = [pc];
    const item = new FakeItem('datapad');
    InventoryManager.inventory.push(item as any);

    InventoryManager.removeItem(item as any, 1);

    expect(seen).toEqual([[item, pc]]);
    expect(InventoryManager.inventory).toHaveLength(0);
  });

  test('looting a placeable moves each stack once and fires one acquire per stack', () => {
    const module = runningModule();
    const from: any[] = [];
    module.scripts[ModuleObjectScript.ModuleOnPlayerAcquireItem] = stubScript((instance) => {
      from.push(call(moduleRoutines.GetModuleItemAcquiredFrom, instance));
    }).script;
    const footlocker = Object.create(ModulePlaceable.prototype) as ModulePlaceable;
    footlocker.scripts = {} as any;
    const medpacs = new FakeItem('g_i_medeqpmnt01', 3, true);
    footlocker.inventory = [medpacs as any];

    footlocker.retrieveInventory();

    expect(InventoryManager.inventory).toEqual([medpacs]);
    expect(medpacs.getStackSize()).toBe(3);
    expect(from).toEqual([footlocker]);
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

  test('SetLocalBoolean/SetLocalNumber on GetModule() and custom tokens round-trip a save', async () => {
    const module = new Module();
    module.setFromIFO(baseIFO(), false);
    module.area = { saveAreaListStruct: () => baseIFO().getFieldByLabel('Mod_Area_list').getChildStructs()[0], save: jest.fn() } as any;
    module.filename = 'end_m01aa';
    state.module = module;
    const self = {};
    const oModule = call(moduleRoutines.GetModule, self);
    call(localVarRoutines.SetLocalBoolean, self, oModule, 0, 1);
    call(localVarRoutines.SetLocalBoolean, self, oModule, 31, 1);
    call(localVarRoutines.SetLocalBoolean, self, oModule, 70, 1);
    call(localVarRoutines.SetLocalNumber, self, oModule, 3, 42);
    module.setCustomToken(51, 'Revan');

    state.TwoDAManager.datatables.set('modulesave', { getRowByColumnAndValue: () => ({ includeInSave: '0' }) });
    state.PartyManager = { Save: jest.fn(), ExportPartyMemberTemplates: jest.fn(async () => {}), party: [] };
    state.InventoryManager = { Save: jest.fn(async () => {}) };
    await module.save(true);

    const reloaded = new Module();
    reloaded.setFromIFO(new GFFObject(module.ifo.getExportBuffer()), true);
    state.module = reloaded;
    const oReloaded = call(moduleRoutines.GetModule, self);

    expect([0, 1, 31, 70].map((i) => call(localVarRoutines.GetLocalBoolean, self, oReloaded, i))).toEqual([1, 0, 1, 1]);
    expect(call(localVarRoutines.GetLocalNumber, self, oReloaded, 3)).toBe(42);
    expect(call(localVarRoutines.GetLocalNumber, self, oReloaded, 4)).toBe(0);
    expect(reloaded.getCustomToken(51)).toBe('Revan');
  });

  test('locals on an invalid object are ignored rather than throwing', () => {
    state.module = new Module();
    expect(() => call(localVarRoutines.SetLocalNumber, {}, undefined, 1, 5)).not.toThrow();
    expect(call(localVarRoutines.GetLocalBoolean, {}, undefined, 1)).toBe(0);
  });
});
