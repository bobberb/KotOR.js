import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Load one real engine source file with every import replaced by an inert stub except the
 * ones supplied. For classes whose normal import graph drags in the renderer (three/examples
 * ESM, which jest cannot parse): the methods under test run their real bodies against the
 * real managers the test passes in.
 *
 * @param file path relative to src/, e.g. 'module/ModuleArea.ts'
 * @param imports import specifier (as written in the source) -> module object to hand back
 */
export function loadSourceWithStubs(file: string, imports: Record<string, any>): any {
  const filename = path.resolve(__dirname, '..', '..', file);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const stub: any = new Proxy(function(){}, {
    get(target: any, key) {
      if(key === '__esModule') return true;
      if(key === 'prototype') return target.prototype;
      if(key === 'then') return undefined;
      if(key === Symbol.toPrimitive || key === 'valueOf') return () => 0;
      if(key === 'toString') return () => '';
      return stub;
    },
    construct() { return stub; },
    apply() { return stub; },
  });
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', js)((id: string) => {
    if(id in imports) return imports[id];
    if(id === 'path') return path;
    return stub;
  }, module, module.exports);
  return module.exports;
}
