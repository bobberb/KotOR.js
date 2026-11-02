import { beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/loaders', () => ({ ResourceLoader: {}, MDLLoader: { loader: { load: async (): Promise<undefined> => undefined } } }));
jest.mock('@/loaders/MDLLoader', () => ({ MDLLoader: { loader: { load: async (): Promise<undefined> => undefined } } }));
jest.mock('@/module/ModuleCreature', () => ({ ModuleCreature: class {} }));
jest.mock('@/module/ModulePlayer', () => ({ ModulePlayer: class {} }));
jest.mock('@/three/odyssey', () => ({ OdysseyModel3D: class {} }));
jest.mock('@/engine/CurrentGame', () => ({ CurrentGame: { gameinprogress_dir: 'gip' } }));
jest.mock('@/utility/GameFileSystem', () => ({ GameFileSystem: { readFile: async () => new Uint8Array() } }));

import { GameState } from '@/GameState';
import { PartyManager } from '@/managers/PartyManager';
import { Planetary } from '@/engine/Planetary';
import { GFFObject } from '@/resource/GFFObject';
import { GFFField } from '@/resource/GFFField';
import { GFFDataType } from '@/enums/resource/GFFDataType';

const state = GameState as any;
const ROWS = ['EndarSpire', 'Taris', 'Dantooine', 'Tatooine'].map((label, i) => ({
  __rowlabel: String(i), label, name: '0', description: '0', icon: '****', model: '****', guitag: `LBL_Planet_${label}`, lockedoutreason: '****',
}));

beforeEach(async () => {
  const rows: Record<number, any> = {};
  ROWS.forEach((row, i) => rows[i] = row);
  state.TwoDAManager = { datatables: new Map([['planetary', { rows, RowCount: ROWS.length }]]) };
  state.Planetary = Planetary;
  state.PartyManager = PartyManager;
  state.TutorialWindowTracker = [];
  const manager = () => ({ ClearEntries: jest.fn(), AddEntry: jest.fn() });
  state.JournalManager = manager();
  state.DialogMessageManager = manager();
  state.FeedbackMessageManager = manager();
  await Planetary.Init();
});

describe('PartyManager PARTYTABLE load restores the galaxy map', () => {
  test('selected planet plus available/selectable masks survive SaveStruct -> binary PARTYTABLE -> PartyManager.Load', async () => {
    Planetary.SetPlanetAvailable(1, true);
    Planetary.SetPlanetAvailable(2, true);
    Planetary.SetPlanetSelectable(2, true);
    Planetary.SetSelectedPlanet(2);

    const partytable = new GFFObject();
    partytable.FileType = 'PT  ';
    partytable.RootNode.addField(new GFFField(GFFDataType.STRUCT, 'GlxyMap')).addChildStruct(Planetary.SaveStruct());
    partytable.RootNode.addField(new GFFField(GFFDataType.DWORD, 'PT_GOLD')).setValue(0);
    const bytes = partytable.getExportBuffer();

    // Session being replaced: different selection and stale flags that the load must overwrite.
    await Planetary.Init();
    Planetary.SetSelectedPlanet(3);
    Planetary.SetPlanetAvailable(3, true);
    Planetary.SetPlanetSelectable(3, true);
    await PartyManager.Load(new GFFObject(bytes));

    expect(Planetary.selectedIndex).toBe(2);
    expect(Planetary.planets.map(p => p.enabled)).toEqual([false, true, true, false]);
    expect(Planetary.planets.map(p => p.selectable)).toEqual([false, false, true, false]);
  });
});
