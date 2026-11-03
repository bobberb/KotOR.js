import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

/**
 * Every field `ItemProperty.save()` writes has to come back through
 * `initProperties()`, or it is silently lost on load.
 *
 * Two were not, once. The writer emitted 'SubType' and 'Usable' where the
 * reader -- and the retail data -- use 'Subtype' and 'Useable'. Items loaded
 * from a module were fine and items loaded from a save were not: subType came
 * back undefined, `subTypeDef.rows[undefined]` missed, and a Peragus save load
 * emitted `Invalid Item Property Sub Type: undefined` 36 times. `useable` was
 * lost the same way, without announcing itself at all.
 *
 * This used to scrape the source for `hasField('X')`, which broke the moment
 * the reader moved to `getTemplateFieldValue([...])` with no change in
 * behaviour. It now builds a property, saves it, reloads the saved struct
 * through the binary GFF format and compares every field.
 */

jest.mock('@/GameState', () => ({ GameState: {} }));
jest.mock('@/managers/TLKManager', () => ({ TLKManager: {} }));

import { GameState } from '@/GameState';
import { ItemProperty } from '@/engine/ItemProperty';
import { GFFObject } from '@/resource/GFFObject';
import { GFFField } from '@/resource/GFFField';
import { GFFDataType } from '@/enums/resource/GFFDataType';

const state = GameState as any;

/**
 * The retail spelling and GFF type of each property-struct field, from the
 * item blueprints shipped in the install (101PER's .uti PropertiesList).
 */
const RETAIL_FIELDS: Array<[string, GFFDataType, keyof ItemProperty]> = [
  ['PropertyName', GFFDataType.WORD, 'propertyName'],
  ['Subtype', GFFDataType.WORD, 'subType'],
  ['CostTable', GFFDataType.BYTE, 'costTable'],
  ['CostValue', GFFDataType.WORD, 'costValue'],
  ['Param1', GFFDataType.BYTE, 'param1'],
  ['Param1Value', GFFDataType.BYTE, 'param1Value'],
  ['ChanceAppear', GFFDataType.BYTE, 'chanceAppear'],
  ['UsesPerDay', GFFDataType.BYTE, 'usesPerDay'],
  ['Useable', GFFDataType.BYTE, 'useable'],
  ['UpgradeType', GFFDataType.BYTE, 'upgradeType'],
];

const subTypeRows: Record<number, any> = { 3: { __index: 3, name: '-1', label: 'Blaster' } };

function propertyStruct(values: Record<string, number>, labels: Record<string, string> = {}): GFFObject {
  const gff = new GFFObject();
  for (const [label, type] of RETAIL_FIELDS) {
    if (label in values) gff.RootNode.addField(new GFFField(type, labels[label] || label)).setValue(values[label]);
  }
  return gff;
}

/** Save, serialise to bytes, parse, and load a fresh property from the result. */
function reload(property: ItemProperty): { saved: GFFObject, reloaded: ItemProperty } {
  const container = new GFFObject();
  container.RootNode = property.save();
  const saved = new GFFObject(container.getExportBuffer());
  return { saved, reloaded: new ItemProperty(saved, {}) };
}

let consoleError: jest.SpiedFunction<typeof console.error>;

beforeEach(() => {
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  state.SWRuleSet = {
    itemPropsDef: {
      // propertyName 11 has a subtype table, 12 does not.
      11: { hasSubType: () => true, subtyperesref: 'IPRP_DAMAGETYPE' },
      12: { hasSubType: () => false },
    },
    costTables: { 2: { name: 'IPRP_BONUSCOST' } },
  };
  state.TwoDAManager = {
    datatables: new Map<string, any>([
      ['iprp_damagetype', { rows: subTypeRows }],
      ['iprp_bonuscost', { rows: [] }],
    ]),
  };
});

afterEach(() => jest.restoreAllMocks());

describe('item property fields survive a save round trip', () => {
  const VALUES = {
    PropertyName: 11, Subtype: 3, CostTable: 2, CostValue: 4, Param1: 7,
    Param1Value: 9, ChanceAppear: 100, UsesPerDay: 2, Useable: 1, UpgradeType: 5,
  };

  test('every field comes back with its value', () => {
    const original = new ItemProperty(propertyStruct(VALUES), {});
    const { reloaded } = reload(original);
    for (const [, , key] of RETAIL_FIELDS) {
      expect([key, reloaded[key]]).toEqual([key, original[key]]);
    }
    expect(reloaded.subType).toBe(3);
    expect(reloaded.useable).toBe(1);
    expect(reloaded.getSubType()?.label).toBe('Blaster');
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('the saved struct uses the retail spelling of every label, once', () => {
    const { saved } = reload(new ItemProperty(propertyStruct(VALUES), {}));
    const labels = saved.RootNode.getFields().map((field) => field.label);
    expect([...labels].sort()).toEqual(RETAIL_FIELDS.map(([label]) => label).sort());
  });

  test('a struct written with the legacy SubType/Usable spellings still loads', () => {
    const legacy = propertyStruct(VALUES, { Subtype: 'SubType', Useable: 'Usable' });
    const property = new ItemProperty(legacy, {});
    expect(property.subType).toBe(3);
    expect(property.useable).toBe(1);
  });

  test('-1 (none) is stored as 255 and comes back as -1', () => {
    const original = new ItemProperty(propertyStruct({ ...VALUES, PropertyName: 12, UpgradeType: 255, CostTable: 255 }), {});
    expect(original.upgradeType).toBe(-1);
    expect(original.costTable).toBe(-1);
    const { saved, reloaded } = reload(original);
    expect(saved.RootNode.getFieldByLabel('UpgradeType').getValue()).toBe(255);
    expect(reloaded.upgradeType).toBe(-1);
    expect(reloaded.costTable).toBe(-1);
  });
});

describe('a missing definition is not fabricated', () => {
  test('a subtype row the lookup missed leaves no subtype definition', () => {
    // From2DA's `row: any = {}` default would turn the miss into a subtype with
    // id -1 and an empty label, which downstream cannot tell from a real one.
    const property = new ItemProperty(propertyStruct({ PropertyName: 11, Subtype: 99, CostTable: 255 }), {});
    expect(property.getSubType()).toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith('Invalid Item Property Sub Type: 99');
  });

  test.each([255, 77])('a cost table with no lookup (stored %s) does not dereference the miss', (costTable) => {
    let property: ItemProperty | undefined;
    expect(() => {
      property = new ItemProperty(propertyStruct({ PropertyName: 12, CostTable: costTable }), {});
    }).not.toThrow();
    expect(property!.costTableDefinition).toBeUndefined();
  });
});
