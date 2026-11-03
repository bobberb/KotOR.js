import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import * as ts from "typescript";

const root = path.resolve(__dirname, "../../..");

/**
 * Load real definition/registration code without initializing the browser engine.
 * GameState is a controlled fixture; enum values, BitWise and Three are real.
 * This deliberately does not replace the separate full-project type/build check.
 */
export function harness() {
  const cache = new Map<string, any>();
  const gameState: any = {};
  const mock: any = new Proxy(function() {}, {
    get(target, key) { if (key === "__esModule") return true; if (key === "prototype") return target.prototype; return mock; },
    construct() { return mock; },
    apply() { return mock; },
  });
  function load(filename: string): any {
    filename = path.resolve(filename);
    if (!path.extname(filename)) filename = fs.existsSync(filename + ".ts") ? filename + ".ts" : path.join(filename, "index.ts");
    if (cache.has(filename)) return cache.get(filename);
    const exports: any = {};
    cache.set(filename, exports);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const requireModule = (name: string): any => {
      if (name === "three") return require("three");
      const resolved = name.startsWith("@/") ? path.join(root, "src", name.slice(2)) : path.resolve(path.dirname(filename), name);
      if (resolved === path.join(root, "src/GameState")) return { GameState: gameState };
      if (/\/src\/effects\/(GameEffect|EffectDamage)$/.test(resolved)) return load(resolved);
      if (resolved.includes("/nwscript/builtins") || resolved.includes("/src/enums/") ||
          /\/(routineMetadata|reconciledActions|engineRoutineFallbacks|NWScriptConstants|NWScriptDef|NWScriptDefK1|NWScriptDefK2|BitWise)$/.test(resolved)) return load(resolved);
      return mock;
    };
    vm.runInNewContext(code, { exports, require: requireModule, console, Object, Set, Map, WeakSet, Math }, { filename });
    return exports;
  }
  const loadScript = (p: string) => load(path.join(root, "src/nwscript", p));
  const kotor = loadScript("NWScriptDefK1").NWScriptDefK1.Actions;
  const tsl = loadScript("NWScriptDefK2").NWScriptDefK2.Actions;
  return { kotor, tsl, gameState, loadScript, load };
}

