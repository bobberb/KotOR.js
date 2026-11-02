import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/loaders/MDLLoader', () => ({ MDLLoader: { loader: { load: async (): Promise<undefined> => undefined } } }));

import { GameState } from '@/GameState';
import * as PlanetaryModule from '@/engine/Planetary';
import { Planetary } from '@/engine/Planetary';
import { GetPlanetAvailable, GetPlanetSelectable, GetSelectedPlanet, SetPlanetAvailable, SetPlanetSelectable, ShowGalaxyMap } from '@/nwscript/builtins/galaxy';
import { buildRuntimeAction, EngineVariant } from '@/nwscript/builtins/actionBuilder';
import { GFFObject } from '@/resource/GFFObject';
import { GFFField } from '@/resource/GFFField';
import { GFFStruct } from '@/resource/GFFStruct';
import { GFFDataType } from '@/enums/resource/GFFDataType';

const state = GameState as any;

// Synthetic planetary.2da: K1-ish row order, no game assets.
const PLANET_ROWS = [
  { label: 'EndarSpire', guitag: 'LBL_Planet_EndarSpire', lockedoutreason: '****' },
  { label: 'Taris', guitag: 'LBL_Planet_Taris', lockedoutreason: '****' },
  { label: 'Dantooine', guitag: 'LBL_Planet_Dantooine', lockedoutreason: '****' },
  { label: 'Tatooine', guitag: 'LBL_Planet_Tatooine', lockedoutreason: '****' },
  { label: 'Leviathan', guitag: 'LBL_Planet_Leviathan', lockedoutreason: '4242' },
].map((row, i) => ({ __rowlabel: String(i), name: String(10 + i), description: String(20 + i), icon: '****', model: '****', ...row }));
const TARIS = 1, DANTOOINE = 2, TATOOINE = 3, LEVIATHAN = 4;

async function initPlanetary(planetRows: any[] = PLANET_ROWS) {
  const rows: Record<number, any> = {};
  planetRows.forEach((row, i) => rows[i] = row);
  state.TwoDAManager = { datatables: new Map([['planetary', { rows, RowCount: planetRows.length }]]) };
  state.TLKManager = { TLKStrings: Array.from({ length: 40 }, (_, i) => ({ Value: `str${i}` })) };
  await Planetary.Init();
}

function routine(def: any, engine: EngineVariant) {
  const built = buildRuntimeAction(def, engine)!;
  return (...args: any[]) => built.action!.call({}, args);
}

/** Load the real menu source with its engine imports replaced by stubs (no renderer/assets). */
function loadMenu(file: string, exportName: string, imports: Record<string, any>): any {
  const filename = path.resolve(__dirname, '..', file);
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', result.outputText)((id: string) => {
    if (!(id in imports)) throw new Error(`Unexpected menu dependency: ${id}`);
    return imports[id];
  }, module, module.exports);
  return module.exports[exportName];
}

class FakeControl {
  listeners = new Map<string, Function>();
  visible = true;
  widget = { scale: { setScalar: jest.fn() }, userData: { fill: { visible: true } } };
  constructor(public name = '') {}
  addEventListener(type: string, fn: Function) { this.listeners.set(type, fn); }
  removeEventListener(type: string) { this.listeners.delete(type); }
  click() { this.listeners.get('click')?.({ stopPropagation() {} }); }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  disableBorder() {}
  setText() {}
  getFill(): any { return { material: {} }; }
}

class FakeGameMenu {
  closed = 0;
  controls = new Map<string, FakeControl>();
  tGuiPanel: any;
  manager: any;
  async menuControlInitializer() {}
  show() {}
  close() { this.closed++; }
  getControlByName(name: string) { return this.controls.get(name); }
}

class FakeLBL3DView { setControl() {} addModel() {} removeModel() {} render() {} camera = { position: { copy() {} }, quaternion: { copy() {} } }; }

/** Stands in for k_sup_galaxymap: records the destination it would travel to. */
let travelledTo: number[] = [];
let gameKey: EngineVariant = 'kotor';
class FakeScriptInstance {
  run = jest.fn(() => { travelledTo.push(routine(GetSelectedPlanet, gameKey)()); });
}

const baseImports = () => ({
  '@/GameState': { GameState: state },
  '@/gui': { GameMenu: FakeGameMenu, LBL_3DView: FakeLBL3DView },
  '@/loaders': { MDLLoader: { loader: { load: async () => { throw new Error('no assets in tests'); } } }, TextureLoader: { LoadQueue: async () => {} } },
  '@/nwscript/NWScript': { NWScript: { Load: () => new FakeScriptInstance(), SetGlobalScript() {} } },
  '@/nwscript/NWScriptInstance': { NWScriptInstance: FakeScriptInstance },
  '@/odyssey': {},
  '@/engine/Planetary': PlanetaryModule,
  '@/three/odyssey': { OdysseyModel3D: { FromMDL: async () => ({}) } },
});
const K1Menu = loadMenu('game/kotor/menu/MenuGalaxyMap.ts', 'MenuGalaxyMap', baseImports());
const TSLMenu = loadMenu('game/tsl/menu/MenuGalaxyMap.ts', 'MenuGalaxyMap', {
  ...baseImports(),
  '@/game/kotor/KOTOR': { MenuGalaxyMap: K1Menu },
});

async function openMenu(MenuClass: any) {
  const menu = new MenuClass();
  for (const name of ['BTN_BACK', 'BTN_ACCEPT', '_3D_PlanetModel', '_3D_PlanetDisplay', 'LBL_PLANETNAME', 'LBL_DESC']) menu[name] = new FakeControl(name);
  const planetControls = PLANET_ROWS.map(row => new FakeControl(row.guitag));
  planetControls.forEach(c => menu.controls.set(c.name, c));
  menu.tGuiPanel = { children: planetControls, widget: { userData: { fill: { visible: true } } } };
  menu.manager = { MenuGalaxyMap: menu };
  // Initializer stops at the (absent) galaxy model; buttons are wired before that point.
  await menu.menuControlInitializer().catch((): undefined => undefined);
  return menu;
}

beforeEach(async () => {
  travelledTo = [];
  state.MenuManager = { InGameConfirm: { fromStringRef: jest.fn() } };
  state.PartyManager = { party: [{}] };
  await initPlanetary();
});

describe.each([['kotor', K1Menu], ['tsl', TSLMenu]] as const)('%s galaxy map menu', (engine, MenuClass) => {
  beforeEach(() => {
    gameKey = engine;
    state.MenuManager.MenuGalaxyMap = undefined;
    [TARIS, DANTOOINE, TATOOINE, LEVIATHAN].forEach(i => routine(SetPlanetAvailable, engine)(i, 1));
    [TARIS, DANTOOINE, TATOOINE].forEach(i => routine(SetPlanetSelectable, engine)(i, 1));
  });

  test('ShowGalaxyMap opens on the current planet and clicking a planet makes GetSelectedPlanet return it', async () => {
    const menu = await openMenu(MenuClass);
    state.MenuManager.MenuGalaxyMap = { open: () => menu.show() };
    routine(ShowGalaxyMap, engine)(TARIS);
    expect(routine(GetSelectedPlanet, engine)()).toBe(TARIS);

    menu.controls.get('LBL_Planet_Dantooine').click();
    expect(routine(GetSelectedPlanet, engine)()).toBe(DANTOOINE);

    menu.BTN_ACCEPT.click();
    expect(travelledTo).toEqual([DANTOOINE]);
    expect(menu.closed).toBe(1);
  });

  test('accepting the planet the party is already on does not travel', async () => {
    const menu = await openMenu(MenuClass);
    Planetary.SetSelectedPlanet(TARIS);
    menu.show();
    menu.controls.get('LBL_Planet_Dantooine').click();
    menu.controls.get('LBL_Planet_Taris').click();
    menu.BTN_ACCEPT.click();
    expect(travelledTo).toEqual([]);
    expect(state.MenuManager.InGameConfirm.fromStringRef).toHaveBeenCalledWith(125629);
    expect(menu.closed).toBe(0);
  });

  test('an unselectable planet shows its lockout reason and cannot become the destination', async () => {
    const menu = await openMenu(MenuClass);
    Planetary.SetSelectedPlanet(TARIS);
    menu.show();
    menu.controls.get('LBL_Planet_Leviathan').click();
    expect(routine(GetSelectedPlanet, engine)()).toBe(TARIS);
    menu.BTN_ACCEPT.click();
    expect(state.MenuManager.InGameConfirm.fromStringRef).toHaveBeenCalledWith(4242);
    expect(travelledTo).toEqual([]);
    expect(menu.closed).toBe(0);
  });

  test('an unavailable planet is hidden and cannot be selected even if marked selectable', async () => {
    routine(SetPlanetAvailable, engine)(TATOOINE, 0);
    expect(routine(GetPlanetAvailable, engine)(TATOOINE)).toBe(0);
    expect(routine(GetPlanetSelectable, engine)(TATOOINE)).toBe(1);
    const menu = await openMenu(MenuClass);
    Planetary.SetSelectedPlanet(TARIS);
    menu.show();
    const tatooine = menu.controls.get('LBL_Planet_Tatooine');
    expect(tatooine.visible).toBe(false);
    expect(tatooine.listeners.has('click')).toBe(false);
    menu.changePlanet(Planetary.GetPlanetByIndex(TATOOINE));
    expect(routine(GetSelectedPlanet, engine)()).toBe(TARIS);
    menu.BTN_ACCEPT.click();
    expect(travelledTo).toEqual([]);
  });

  test('backing out restores the planet the map opened on', async () => {
    const menu = await openMenu(MenuClass);
    Planetary.SetSelectedPlanet(TARIS);
    menu.show();
    menu.controls.get('LBL_Planet_Dantooine').click();
    menu.BTN_BACK.click();
    expect(routine(GetSelectedPlanet, engine)()).toBe(TARIS);
    expect(travelledTo).toEqual([]);
    expect(menu.closed).toBe(1);
  });

  test('accept with no planet shown (nothing selected) does not throw', async () => {
    const menu = await openMenu(MenuClass);
    Planetary.SetSelectedPlanet(-1);
    menu.show();
    expect(() => menu.BTN_ACCEPT.click()).not.toThrow();
    expect(travelledTo).toEqual([]);
  });

  test('reopening with no valid planet forgets the planet browsed last time', async () => {
    const menu = await openMenu(MenuClass);
    state.MenuManager.MenuGalaxyMap = { open: () => menu.show() };
    routine(ShowGalaxyMap, engine)(TARIS);
    menu.controls.get('LBL_Planet_Dantooine').click();
    menu.BTN_BACK.click();
    routine(ShowGalaxyMap, engine)(-1);
    menu.BTN_ACCEPT.click();
    routine(ShowGalaxyMap, engine)(99);
    menu.BTN_ACCEPT.click();
    expect(travelledTo).toEqual([]);
  });

  test('planet routines ignore out-of-range indices instead of throwing', () => {
    expect(() => routine(SetPlanetAvailable, engine)(99, 1)).not.toThrow();
    expect(() => routine(SetPlanetSelectable, engine)(99, 1)).not.toThrow();
    expect(routine(GetPlanetAvailable, engine)(99)).toBe(0);
    expect(routine(GetPlanetSelectable, engine)(99)).toBe(0);
  });
});

describe('galaxy map save/load', () => {
  function roundTrip(struct: GFFStruct) {
    const gff = new GFFObject();
    gff.FileType = 'PT  ';
    gff.RootNode.addField(new GFFField(GFFDataType.STRUCT, 'GlxyMap')).addChildStruct(struct);
    const loaded = new GFFObject(gff.getExportBuffer());
    return loaded.getFieldByLabel('GlxyMap').getChildStructs()[0];
  }

  test('selected planet, available mask and selectable mask survive a binary PARTYTABLE round trip', async () => {
    [TARIS, DANTOOINE, LEVIATHAN].forEach(i => Planetary.SetPlanetAvailable(i, true));
    [TARIS, DANTOOINE].forEach(i => Planetary.SetPlanetSelectable(i, true));
    Planetary.SetSelectedPlanet(DANTOOINE);
    const saved = roundTrip(Planetary.SaveStruct());

    await initPlanetary();
    // Stale state from the session being replaced must not leak through the load.
    Planetary.SetPlanetAvailable(TATOOINE, true);
    Planetary.SetPlanetSelectable(TATOOINE, true);
    Planetary.LoadStruct(saved);

    expect(Planetary.selectedIndex).toBe(DANTOOINE);
    expect(Planetary.selected?.label).toBe('Dantooine');
    expect(Planetary.planets.map(p => p.enabled)).toEqual([false, true, true, false, true]);
    expect(Planetary.planets.map(p => p.selectable)).toEqual([false, true, true, false, false]);
  });

  test('a retail save without a selectable mask leaves available planets travelable', async () => {
    const struct = new GFFStruct();
    struct.addField(new GFFField(GFFDataType.DWORD, 'GlxyMapNumPnts')).setValue(5);
    struct.addField(new GFFField(GFFDataType.DWORD, 'GlxyMapPlntMsk')).setValue((1 << TARIS) | (1 << TATOOINE));
    struct.addField(new GFFField(GFFDataType.INT, 'GlxyMapSelPnt')).setValue(TATOOINE);
    Planetary.LoadStruct(roundTrip(struct));
    expect(Planetary.selectedIndex).toBe(TATOOINE);
    expect(Planetary.planets.map(p => p.selectable)).toEqual([false, true, false, true, false]);
  });

  const syntheticRows = (count: number) => Array.from({ length: count }, (_, i) => ({ __rowlabel: String(i), label: `P${i}`, name: '0', description: '0', icon: '****', model: '****', guitag: `LBL_P${i}`, lockedoutreason: '****' }));
  function mapStruct(count: number, available: number, selectable: number, selected: number) {
    const struct = new GFFStruct();
    struct.addField(new GFFField(GFFDataType.DWORD, 'GlxyMapNumPnts')).setValue(count);
    struct.addField(new GFFField(GFFDataType.DWORD, 'GlxyMapPlntMsk')).setValue(available >>> 0);
    struct.addField(new GFFField(GFFDataType.INT, 'GlxyMapSelPnt')).setValue(selected);
    struct.addField(new GFFField(GFFDataType.DWORD, 'GlxyMapSelMsk')).setValue(selectable >>> 0);
    return roundTrip(struct);
  }

  test('planets past the saved planet count are reset even if mask bits are set', () => {
    Planetary.LoadStruct(mapStruct(2, 0b11111, 0b11111, TARIS));
    expect(Planetary.planets.map(p => p.enabled)).toEqual([true, true, false, false, false]);
    expect(Planetary.planets.map(p => p.selectable)).toEqual([true, true, false, false, false]);
  });

  test('a 2da with more than 32 planets does not alias planet 32 onto bit 0 when loading', async () => {
    await initPlanetary(syntheticRows(34));
    Planetary.LoadStruct(mapStruct(34, 0b1, 0b1, 0));
    expect(Planetary.planets[0].enabled).toBe(true);
    expect(Planetary.planets[32].enabled).toBe(false);
    expect(Planetary.planets[32].selectable).toBe(false);
    expect(Planetary.planets[33].enabled).toBe(false);
  });

  test('planet ids >= 32 are left out of the save masks instead of wrapping onto low bits', async () => {
    await initPlanetary(syntheticRows(34));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    Planetary.SetPlanetAvailable(32, true);
    Planetary.SetPlanetSelectable(33, true);
    Planetary.SetPlanetAvailable(31, true);
    const saved = roundTrip(Planetary.SaveStruct());
    expect(saved.getFieldByLabel('GlxyMapPlntMsk').getValue()).toBe(0x80000000);
    expect(saved.getFieldByLabel('GlxyMapSelMsk').getValue()).toBe(0);
  });

  test('a missing GlxyMap struct leaves the current map untouched', () => {
    Planetary.SetPlanetAvailable(TARIS, true);
    Planetary.SetSelectedPlanet(TARIS);
    expect(() => Planetary.LoadStruct(undefined)).not.toThrow();
    expect(Planetary.selectedIndex).toBe(TARIS);
    expect(Planetary.planets[TARIS].enabled).toBe(true);
  });

  test('a save recording more planets than planetary.2da has loads without throwing', () => {
    const struct = new GFFStruct();
    struct.addField(new GFFField(GFFDataType.DWORD, 'GlxyMapNumPnts')).setValue(20);
    struct.addField(new GFFField(GFFDataType.DWORD, 'GlxyMapPlntMsk')).setValue(0xFFFFF);
    struct.addField(new GFFField(GFFDataType.INT, 'GlxyMapSelPnt')).setValue(TARIS);
    expect(() => Planetary.LoadStruct(roundTrip(struct))).not.toThrow();
    expect(Planetary.planets.every(p => p.enabled)).toBe(true);
  });
});
