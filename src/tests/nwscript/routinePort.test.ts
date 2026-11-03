import { beforeAll, describe, expect, jest, test } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { createHash } from "crypto";
import { harness } from "./routineHarness";

const root = path.resolve(__dirname, "../../..");
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
const baseline = fixture("upstreamActionManifest.json");
const preservation = fixture("upstreamPreservedBodies.json");

/**
 * Preserved upstream routines whose body we changed on purpose. The fixture keeps
 * the upstream hash (it is upstream's record, not ours); the divergence is pinned
 * by a behavioral test below instead. GetFortitude/Will/ReflexSavingThrow: saves
 * are derived at runtime (ModuleCreature.getTotal*Save()), so the stored
 * *SaveThrow field upstream returns is only the miscellaneous bonus.
 * GetNearestTrapToObject (488): upstream read the VM arguments in the wrong
 * order ([oTarget, nTrapDetected] was taken as [mask, oTarget]) so it always
 * returned OBJECT_INVALID, ignored nTrapDetected, and tested raw trapFlag.
 * Now: nearest armed trap (isObjectTrapped) to oTarget, detected by oTarget's
 * side when nTrapDetected is TRUE. SetTrapDisabled (555): also
 * clears the trap's detection (ModuleTrigger.disableTrap) so a disabled trap is
 * not left visible and targetable. Both pinned in traps-security.test.ts.
 * ActionCastFakeSpellAtObject (501): marks its ActionCastSpell as fake so it
 * plays animations only, with no FP cost, impact script or combat round
 * (pinned in force-powers.test.ts).
 * SWMG_OnBulletHit/OnObstacleHit/OnDeath/OnDamage (591/592/598/605): upstream bodies
 * were commented-out no-ops; they now run the engine default handlers.
 * SWMG_SetFollowerHitPoints (604): upstream ran the caller's OnDamage instead of
 * setting the follower's hit points. SWMG_Get/SetGunBankBulletModel (625/632):
 * upstream returned/overwrote the bullet GFF template instead of the model name.
 * Pinned by src/tests/minigames/swoop-turret-routines.test.ts.
 */
const DELIBERATE_DIVERGENCES = new Set([488, 491, 492, 493, 501, 555, 591, 592, 598, 604, 605, 625, 632]);

let runtime: ReturnType<typeof harness>;
beforeAll(() => { runtime = harness(); });

describe("ported action-table preservation", () => {
  test.each(["kotor", "tsl"] as const)("%s retains every upstream ID/name/type/argument signature", (engine) => {
    const actions = runtime[engine];
    expect(Object.keys(actions).map(Number)).toEqual(baseline[engine].map((row: any[]) => row[0]));
    for (const [id, name, type, args] of baseline[engine]) {
      expect([actions[id].name, actions[id].type, [...actions[id].args]]).toEqual([name, type, args]);
    }
  });

  test("no existing upstream explicit implementation becomes a metadata placeholder", () => {
    const { isEngineRoutineFallback } = runtime.loadScript("engineRoutineFallbacks");
    for (const engine of ["kotor", "tsl"] as const) {
      for (const [id, , , , implemented] of baseline[engine]) {
        if (implemented) {
          expect(typeof runtime[engine][id].action).toBe("function");
          expect(isEngineRoutineFallback(runtime[engine][id])).toBe(false);
        }
      }
    }
  });

  test("all preserved bodies match independently extracted upstream AST hashes", () => {
    const printer = ts.createPrinter({ removeComments: true });
    for (const entry of preservation.preserved) {
      if (DELIBERATE_DIVERGENCES.has(entry.id)) continue;
      const file = ts.createSourceFile(entry.file, fs.readFileSync(path.join(root, entry.file), "utf8"), ts.ScriptTarget.Latest, true);
      let body: ts.Node | undefined;
      function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(file) === entry.name && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
          const member = node.initializer.properties.find(p => p.name?.getText(file) === "action");
          if (member && ts.isPropertyAssignment(member)) body = member.initializer;
        }
        ts.forEachChild(node, visit);
      }
      visit(file);
      expect(body).toBeDefined();
      const hash = createHash("sha256").update(printer.printNode(ts.EmitHint.Unspecified, body!, file)).digest("hex");
      expect(hash).toBe(entry.hash);
    }
  });

  test("preserved routines win over local stubs and K2 inherits by name, not colliding ID", () => {
    const { upstreamKotorActions, upstreamTSLActions } = runtime.loadScript("builtins/upstream");
    for (const entry of preservation.preserved) expect(runtime.kotor[entry.id].action).toBe(upstreamKotorActions[entry.id].action);
    for (const entry of preservation.k2Overrides) expect(runtime.tsl[entry.id].action).toBe(upstreamTSLActions[entry.id].action);
    expect(runtime.kotor[770].name).toBe("PlayMovieQueue");
    expect(runtime.tsl[770].name).toBe("EffectForceBody");
    expect(runtime.tsl[807].action).toBe(runtime.kotor[770].action);
    expect(runtime.tsl[768].action.call({ params: [42] }, [1])).toBe(42);
  });
});

describe("reconciled and recovered behavior", () => {
  test.each(["kotor", "tsl"] as const)("%s scripted damage applies each supported type exactly once", (engine) => {
    const { EffectDamage } = runtime.load(path.join(root, "src/effects/EffectDamage"));
    runtime.gameState.GameEffectFactory = { EffectDamage };
    const caller = { id: 42 };
    for (let slot = 0; slot <= 12; slot++) {
      const effect = runtime[engine][79].action.call({ caller, getSpellId: () => 123 }, [17, 1 << slot, 4]);
      const target = { objectType: 1, effects: [] as unknown[], combatData: {}, subtractHP: jest.fn() };
      effect.setAttachedObject(target);
      effect.onApply();
      expect(target.subtractHP).toHaveBeenCalledTimes(1);
      expect(target.subtractHP).toHaveBeenCalledWith(17);
      expect(effect.getInt(slot)).toBe(17);
      expect(effect.getInt(14)).toBe(-1);
      expect(effect.getDamageType()).toBe(1 << slot);
      expect(effect.getDamagePower()).toBe(4);
      expect(effect.getSpellId()).toBe(123);
      expect(effect.creator).toBe(caller);
      effect.onApply();
      expect(target.subtractHP).toHaveBeenCalledTimes(1);
    }
  });

  test.each([0, 3, 7, -1, 2.5, NaN, Infinity, 1 << 15])("damage mask %s uses one physical fallback rather than an invalid slot", (mask) => {
    const { EffectDamage } = runtime.load(path.join(root, "src/effects/EffectDamage"));
    runtime.gameState.GameEffectFactory = { EffectDamage };
    const effect = runtime.kotor[79].action.call({ caller: {}, getSpellId: () => -1 }, [11, mask, 0]);
    const target = { objectType: 1, effects: [] as unknown[], combatData: {}, subtractHP: jest.fn() };
    effect.setAttachedObject(target);
    effect.onApply();
    expect(effect.getDamageSlots().filter((amount: number) => amount > 0)).toEqual([11]);
    expect(effect.getInt(14)).toBe(11);
    expect(Object.keys(effect.intList).every(key => /^\d+$/.test(key))).toBe(true);
    expect(target.subtractHP).toHaveBeenCalledWith(11);
  });

  test("typed script damage remains susceptible to its type immunity, without physical leakage", () => {
    const { EffectDamage } = runtime.load(path.join(root, "src/effects/EffectDamage"));
    const { GameEffectType } = runtime.load(path.join(root, "src/enums/effects/GameEffectType"));
    runtime.gameState.GameEffectFactory = { EffectDamage };
    const effect = runtime.kotor[79].action.call({ caller: {}, getSpellId: () => -1 }, [20, 1 << 8, 0]);
    const target = {
      objectType: 1,
      effects: [{ type: GameEffectType.EffectDamageImmunityIncrease, getInt: (index: number) => index === 0 ? 1 << 8 : 100 }],
      combatData: {},
      subtractHP: jest.fn(),
    };
    effect.setAttachedObject(target);
    effect.onApply();
    expect(target.subtractHP).toHaveBeenCalledWith(0);
  });

  test("GetAbilityScore uses declared object-then-ability order and handles invalid objects", () => {
    const creature = { objectType: 9, getSTR: () => 18, getDEX: () => 14, getCON: () => 12, getINT: () => 10, getWIS: () => 16, getCHA: () => 8 };
    expect(runtime.kotor[139].action.call({}, [creature, 0])).toBe(18);
    expect(runtime.kotor[139].action.call({}, [creature, 5])).toBe(8);
    expect(runtime.kotor[139].action.call({}, [undefined, 0])).toBe(0);
    expect(runtime.tsl[139].action.call({}, [creature, 4])).toBe(16);
  });

  test("GetObjectType retains AREA support alongside upstream object classifications", () => {
    expect(runtime.kotor[106].action.call({}, [{ objectType: 3 }])).toBe(32768);
    expect(runtime.kotor[106].action.call({}, [undefined])).toBe(-1);
  });

  test("ActionStartConversation preserves local ownership and explicit start-range behavior", () => {
    const actionDialogObject = jest.fn();
    const caller = { objectType: 9, actionDialogObject };
    const listener = { objectType: 9 };
    runtime.kotor[204].action.call({ caller }, [listener, "conversation", 0, 0, 0]);
    expect(actionDialogObject).toHaveBeenLastCalledWith(listener, "conversation", false, 0, 0);
    runtime.tsl[204].action.call({ caller }, [listener, "conversation", 0, 0, 1]);
    expect(actionDialogObject).toHaveBeenLastCalledWith(listener, "conversation", true, 0, 0);
  });

  test("SetCommandable converts NWScript integer booleans for the engine API", () => {
    const setCommandable = jest.fn();
    const object = { objectType: 1, setCommandable };
    runtime.kotor[162].action.call({}, [0, object]);
    expect(setCommandable).toHaveBeenLastCalledWith(false);
    runtime.kotor[162].action.call({}, [1, object]);
    expect(setCommandable).toHaveBeenLastCalledWith(true);
  });

  test("DestroyObject detaches inventory items and preserves creature destruction timing", () => {
    const destroy = jest.fn();
    const item = { objectType: 65, getStackSize: () => 3, destroy };
    const removeItem = jest.fn();
    runtime.gameState.InventoryManager = { inventory: [item], removeItem };
    runtime.kotor[241].action.call({}, [item, 0, 0, 0]);
    expect(removeItem).toHaveBeenCalledWith(item, 3);
    expect(destroy).toHaveBeenCalledTimes(1);
    const creature = { objectType: 9, setWillDestroy: jest.fn(), setDelayUntilDestroy: jest.fn(), setDelayUntilFade: jest.fn(), setNoFadeOnDestroy: jest.fn() };
    runtime.kotor[241].action.call({}, [creature, 2.5, 1, 0.5]);
    expect(creature.setWillDestroy).toHaveBeenCalledWith(true);
    expect(creature.setDelayUntilDestroy).toHaveBeenCalledWith(2.5);
    expect(creature.setDelayUntilFade).toHaveBeenCalledWith(0.5);
    expect(creature.setNoFadeOnDestroy).toHaveBeenCalledWith(true);
  });

  test("TSL skill routines recover base ranks and clamp adjustments", () => {
    const creature = { objectType: 9, skills: [{ rank: 2 }] };
    expect(runtime.tsl[870].action.call({ caller: creature }, [0, undefined])).toBe(2);
    runtime.tsl[869].action.call({}, [creature, 0, -8]);
    expect(creature.skills[0].rank).toBe(0);
  });

  test("TSL movie IDs use real queue implementations and retain skip settings", async () => {
    const queueMovie = jest.fn();
    const playMovieQueue = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    runtime.gameState.VideoManager = { queueMovie, playMovieQueue, movieQueue: [{ skippable: false }] };
    runtime.tsl[806].action.call({}, ["test_movie", 1]);
    expect(queueMovie).toHaveBeenCalledWith("test_movie", true);
    await runtime.tsl[807].action.call({}, [1]);
    expect(runtime.gameState.VideoManager.movieQueue[0].skippable).toBe(true);
    expect(playMovieQueue).toHaveBeenCalledTimes(1);
  });

  test("fallback warnings identify the actual engine and do not count as implementations", () => {
    const { buildEngineRoutineFallbackActionMap, isEngineRoutineFallback } = runtime.loadScript("engineRoutineFallbacks");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const k1 = buildEngineRoutineFallbackActionMap("kotor");
      const k2 = buildEngineRoutineFallbackActionMap("tsl");
      expect(isEngineRoutineFallback(k1[0])).toBe(true);
      expect(k1[0].action([])).toBe(0);
      expect(k2[0].action([])).toBe(0);
      expect(warn.mock.calls[0][0]).toContain("kotor");
      expect(warn.mock.calls[1][0]).toContain("tsl");
      k1[0].action([]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(isEngineRoutineFallback(runtime.kotor[139])).toBe(false);
    } finally { warn.mockRestore(); }
  });
});

describe("saving throw routines", () => {
  test.each(["kotor", "tsl"] as const)("%s GetFortitude/Will/ReflexSavingThrow return the derived total, not the stored bonus", (engine) => {
    const { ModuleObjectType } = runtime.load(path.join(root, "src/enums/module/ModuleObjectType"));
    const creature = {
      objectType: ModuleObjectType.ModuleObject | ModuleObjectType.ModuleCreature,
      // The stored fields hold only the miscellaneous bonus once saves are derived.
      fortitudeSaveThrow: 1, willSaveThrow: 1, reflexSaveThrow: 1,
      getTotalFortitudeSave: () => 7, getTotalWillSave: () => 4, getTotalReflexSave: () => 5,
    };
    const actions = runtime[engine];
    expect([491, 492, 493].map((id) => actions[id].name))
      .toEqual(["GetFortitudeSavingThrow", "GetWillSavingThrow", "GetReflexSavingThrow"]);
    expect(actions[491].action.call({}, [creature])).toBe(7);
    expect(actions[492].action.call({}, [creature])).toBe(4);
    expect(actions[493].action.call({}, [creature])).toBe(5);
  });

  test("an object without derived saves still reports its stored value, and a non-creature 0", () => {
    const { ModuleObjectType } = runtime.load(path.join(root, "src/enums/module/ModuleObjectType"));
    const creature = {
      objectType: ModuleObjectType.ModuleObject | ModuleObjectType.ModuleCreature,
      fortitudeSaveThrow: 3, willSaveThrow: 2, reflexSaveThrow: 1,
    };
    expect(runtime.kotor[491].action.call({}, [creature])).toBe(3);
    expect(runtime.kotor[492].action.call({}, [creature])).toBe(2);
    expect(runtime.kotor[493].action.call({}, [creature])).toBe(1);
    expect(runtime.kotor[491].action.call({}, [{ objectType: ModuleObjectType.ModuleObject }])).toBe(0);
  });
});
