import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

/**
 * Executes the real load()/save() paths of module objects against synthetic
 * GFFs. Earlier guards for these paths read the source text, which is how a
 * merge that left `this.templateResRef = templateResRef` (an undeclared name)
 * in ModuleStore.load(), and duplicate labels in four save() methods, shipped
 * with every test green: the build does not type check, so only running the
 * code catches it.
 */

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/utility/GameFileSystem', () => ({ GameFileSystem: {} }));
jest.mock('@/loaders/ResourceLoader', () => ({ ResourceLoader: {} }));
jest.mock('@/loaders', () => ({ MDLLoader: {}, ResourceLoader: { loadCachedResource: jest.fn() } }));
jest.mock('@/odyssey', () => ({
  OdysseyModel: class {}, OdysseyModelAnimation: class {}, OdysseyWalkMesh: class {},
}));
jest.mock('@/three/odyssey', () => {
  const THREE = jest.requireActual('three') as typeof import('three');
  return {
    OdysseyModel3D: class { quaternion = new THREE.Quaternion(); },
    OdysseyObject3D: class extends THREE.Object3D {},
    OdysseyLightsaberEffect: class {},
  };
});
jest.mock('@/nwscript/NWScript', () => ({ NWScript: class {} }));
jest.mock('@/nwscript/NWScriptInstance', () => ({ NWScriptInstance: class {} }));
jest.mock('@/nwscript/events', () => ({ NWScriptEvent: class {} }));
jest.mock('@/engine/CollisionManager', () => ({ CollisionManager: class {} }));
jest.mock('@/combat', () => ({ CombatRound: class {}, CombatRoundAction: class {} }));

import * as THREE from 'three';
import { GameState } from '@/GameState';
import { ResourceLoader } from '@/loaders';
import { OdysseyModel3D } from '@/three/odyssey';
import { GFFObject } from '@/resource/GFFObject';
import { GFFField } from '@/resource/GFFField';
import { GFFStruct } from '@/resource/GFFStruct';
import { GFFDataType } from '@/enums/resource/GFFDataType';
import { ModuleStore } from '@/module/ModuleStore';
import { ModuleWaypoint } from '@/module/ModuleWaypoint';
import { ModulePlaceable } from '@/module/ModulePlaceable';
import { ModuleDoor } from '@/module/ModuleDoor';
import { ModuleCreature } from '@/module/ModuleCreature';

const state = GameState as any;
const loadCachedResource = ResourceLoader.loadCachedResource as unknown as jest.Mock<(...args: any[]) => any>;

/** Labels that occur more than once in a struct; getFieldByLabel only ever sees the first. */
function duplicateLabels(struct: GFFStruct): string[] {
  const counts = new Map<string, number>();
  for (const field of struct.getFields()) {
    counts.set(field.label, (counts.get(field.label) || 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 1).map(([label]) => label).sort();
}

function gffWith(fields: Array<[GFFDataType, string, any]>): GFFObject {
  const gff = new GFFObject();
  for (const [type, label, value] of fields) {
    gff.RootNode.addField(new GFFField(type, label)).setValue(value);
  }
  return gff;
}

/** Serialise and parse, so the round trip goes through the binary format a savegame uses. */
function reparse(gff: GFFObject): GFFObject {
  return new GFFObject(gff.getExportBuffer());
}

let consoleError: jest.SpiedFunction<typeof console.error>;

beforeEach(() => {
  // Construction logs unrelated noise under Node (no AudioContext, BYTE defaults
  // of -1). Captured rather than printed; tests that care inspect it.
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  loadCachedResource.mockReset();
  state.ModuleObjectManager = {
    AddObjectById: jest.fn(),
    GetNextPlayerId: jest.fn(() => 1),
  };
  state.ActionFactory = { FromStruct: jest.fn(() => undefined) };
  state.NWScript = { Load: jest.fn(() => undefined) };
});

afterEach(() => jest.restoreAllMocks());

describe('ModuleStore.load()', () => {
  test('a GIT store with a blueprint loads it and initializes', () => {
    const utm = gffWith([
      [GFFDataType.INT, 'MarkUp', 140],
      [GFFDataType.INT, 'MarkDown', 25],
      [GFFDataType.CEXOSTRING, 'Tag', 'dan_store'],
    ]);
    loadCachedResource.mockReturnValue(utm.getExportBuffer());
    // The GIT's StoreList names the blueprint `ResRef`.
    const store = new ModuleStore(gffWith([[GFFDataType.RESREF, 'ResRef', 'dan_store']]));

    expect(() => store.load()).not.toThrow();

    expect(loadCachedResource).toHaveBeenCalledWith(expect.anything(), 'dan_store');
    expect(store.initialized).toBe(true);
    expect(store.markUp).toBe(140);
    expect(store.markDown).toBe(25);
    expect(store.templateResRef).toBe('dan_store');
  });

  test('a store whose blueprint is missing still initializes', () => {
    loadCachedResource.mockReturnValue(undefined);
    const store = new ModuleStore(gffWith([
      [GFFDataType.RESREF, 'ResRef', 'gone'],
      [GFFDataType.CEXOSTRING, 'Tag', 'gone_store'],
    ]));

    expect(() => store.load()).not.toThrow();

    expect(store.initialized).toBe(true);
    expect(store.tag).toBe('gone_store');
    expect(store.templateResRef).toBe('gone');
  });

  test('a store reloaded from its own save finds the blueprint through TemplateResRef, saved values winning', () => {
    loadCachedResource.mockReturnValue(gffWith([[GFFDataType.INT, 'MarkUp', 140]]).getExportBuffer());
    const original = new ModuleStore(gffWith([
      [GFFDataType.RESREF, 'ResRef', 'dan_store'],
      [GFFDataType.INT, 'MarkUp', 155],
    ]));
    original.load();
    const saved = reparse(original.save());
    expect(saved.RootNode.hasField('ResRef')).toBe(false);

    loadCachedResource.mockClear();
    const reloaded = new ModuleStore(saved);
    reloaded.load();

    expect(loadCachedResource).toHaveBeenCalledWith(expect.anything(), 'dan_store');
    expect(reloaded.initialized).toBe(true);
    expect(reloaded.markUp).toBe(155);
    expect(reloaded.templateResRef).toBe('dan_store');
  });

  test('a store with no blueprint reference at all initializes from what it has', () => {
    const store = new ModuleStore(gffWith([[GFFDataType.CEXOSTRING, 'Tag', 'bare']]));
    expect(() => store.load()).not.toThrow();
    expect(loadCachedResource).not.toHaveBeenCalled();
    expect(store.initialized).toBe(true);
    expect(store.tag).toBe('bare');
  });
});

describe('save() writes each label once', () => {
  test.each([
    ['ModuleWaypoint', () => new ModuleWaypoint(new GFFObject())],
    ['ModulePlaceable', () => new ModulePlaceable(new GFFObject())],
    ['ModuleStore', () => new ModuleStore(new GFFObject())],
    ['ModuleDoor', () => new ModuleDoor(new GFFObject())],
  ])('%s', (_name, make) => {
    const object = make() as any;
    object.templateResRef = 'blueprint01';
    const saved: GFFObject = object.save();
    expect(duplicateLabels(saved.RootNode)).toEqual([]);
    expect(saved.RootNode.getFieldByLabel('TemplateResRef').getValue()).toBe('blueprint01');
  });

  test.each([
    ['ModulePlaceable', () => new ModulePlaceable(new GFFObject())],
    ['ModuleDoor', () => new ModuleDoor(new GFFObject())],
  ])('%s NotBlastable round-trips', (_name, make) => {
    const object = make() as any;
    object.notBlastable = true;
    expect(object.save().RootNode.getFieldByLabel('NotBlastable').getValue()).toBe(1);
  });
});

describe('ModuleWaypoint facing', () => {
  test('save() writes the live facing, not the facing it was loaded with', () => {
    const waypoint = new ModuleWaypoint(gffWith([
      [GFFDataType.FLOAT, 'XOrientation', 0],
      [GFFDataType.FLOAT, 'YOrientation', 1],
    ]));
    waypoint.initProperties();
    expect(waypoint.xOrientation).toBe(0);

    // Turned 90 degrees since load: facing (0,1,0) rotated about Z by -90 is (1,0,0).
    const model = new (OdysseyModel3D as any)();
    model.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
    (waypoint as any).model = model;

    const saved = reparse(waypoint.save());
    // getFieldByLabel returns the first match, which is what a load reads.
    expect(saved.RootNode.getFieldByLabel('XOrientation').getValue()).toBeCloseTo(1, 5);
    expect(saved.RootNode.getFieldByLabel('YOrientation').getValue()).toBeCloseTo(0, 5);

    const reloaded = new ModuleWaypoint(saved);
    reloaded.initProperties();
    expect(reloaded.xOrientation).toBeCloseTo(1, 5);
    expect(reloaded.yOrientation).toBeCloseTo(0, 5);
  });
});

describe('ModuleCreature save -> load round trip', () => {
  beforeEach(() => {
    state.SWRuleSet = { skills: [], ranges: [], portraits: [] };
    state.FactionManager = { factions: new Map(), AddCreatureToFaction: jest.fn() };
    state.TwoDAManager = { datatables: new Map() };
    state.AppearanceManager = { GetCreatureAppearanceById: (): undefined => undefined };
  });

  /** initProperties() swallows its own exceptions; a thrown one means it stopped part way. */
  function swallowedExceptions(): unknown[] {
    return consoleError.mock.calls.map((call) => call[0]).filter((first) => first instanceof Error);
  }

  function roundTrip(setup: (creature: ModuleCreature) => void): { saved: GFFObject, reloaded: ModuleCreature } {
    const creature = new ModuleCreature(new GFFObject());
    setup(creature);
    const saved = reparse(creature.save());
    const reloaded = new ModuleCreature(saved);
    reloaded.initProperties();
    expect(swallowedExceptions()).toEqual([]);
    return { saved, reloaded };
  }

  test('runtime flags survive', () => {
    const { saved, reloaded } = roundTrip((creature) => {
      creature.stealthMode = true;
      creature.isDestroyable = false;
      creature.subraceIndex = 2;
      creature.subrace = 0;
      creature.isPC = 1;
    });

    expect(saved.RootNode.getFieldByLabel('StealthMode').getValue()).toBe(1);
    expect(saved.RootNode.getFieldByLabel('IsDestroyable').getValue()).toBe(0);
    expect(saved.RootNode.getFieldByLabel('SubraceIndex').getValue()).toBe(2);
    expect(saved.RootNode.getFieldByLabel('IsPC').getValue()).toBe(1);

    expect(reloaded.stealthMode).toBe(true);
    expect(reloaded.isDestroyable).toBe(false);
    expect(reloaded.subraceIndex).toBe(2);
    expect(reloaded.isPC).toBe(1);
  });

  test('defaults survive too', () => {
    const { reloaded } = roundTrip(() => {});
    expect(reloaded.stealthMode).toBe(false);
    expect(reloaded.isDestroyable).toBe(true);
    expect(reloaded.subraceIndex).toBe(0);
    expect(reloaded.isPC).toBe(0);
  });

  test('HitPoints and ForcePoints are clamped to the SHORT range', () => {
    const { saved } = roundTrip((creature) => {
      creature.hitPoints = 40000;
      creature.forcePoints = -40000;
    });
    expect(saved.RootNode.getFieldByLabel('HitPoints').getValue()).toBe(32767);
    expect(saved.RootNode.getFieldByLabel('ForcePoints').getValue()).toBe(-32768);
  });

  test('the creature save writes each label once', () => {
    const { saved } = roundTrip(() => {});
    expect(duplicateLabels(saved.RootNode)).toEqual([]);
  });
});
