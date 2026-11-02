# Autonomous Work Plan — KotOR.js Merged Fork

## Status

- **Fork:** `bobberb/KotOR.js`, cloned to `~/tmp/claudedir/kotor.js`
- **Branch:** `merged-all-prs` (based on `KobaltBlu/KotOR.js` master `002dfe0`)
- **Merged PRs:** #109 (custom chargen K1+TSL), #110 (K1/TSL routine name inheritance), #111 (save/load round-trip fixes), #112 (draft integrated gameplay port — 294 files)
- **Merge commit:** `c2cfc14`
- **Working tree:** clean (merge committed)
- **Post-merge test baseline:** **430/481 tests passing; 49/60 suites passing; 19 failures across 10 suites**

### Conflict resolution summary

16 conflicts across 14 files were resolved with a rule-based script:

| File | Resolution |
|---|---|
| `src/nwscript/NWScriptDefK1.ts`, `NWScriptDefK2.ts` | Took PR #112 stubs (new `builtins/` + `reconciledActions` architecture) |
| `src/engine/ItemProperty.ts` | Took PR #112 (new `getTemplateFieldValue`/`getSaveValue` API) |
| `src/module/ModuleCreature.ts` | Mixed: kept HEAD derived-save methods and missing-skill handling; took PR #112 `clampShort`/`getCommandable` |
| `src/game/kotor/menu/CharGen*.ts` | Kept HEAD `wireControls()` refactor |
| `src/module/ModuleStore.ts` | Kept HEAD's blueprint-loading fix |
| `ModuleDoor`, `ModuleEncounter`, `ModulePlaceable`, `ModuleSound`, `ModuleTrigger`, `ModuleWaypoint` | Combined comment + `TemplateResRef` field |
| `ModuleCamera.ts` | Took PR #112 GFF API (`setOrientation`/`setVector`) |

## Objective

Stabilize the merged branch, fix regressions introduced by conflict resolution, and validate the integrated port so it can be proposed upstream as a coherent set of PRs.

## Phase 1 — Fix Failing Tests (Priority: Critical)

### 1.1 ItemProperty save/load regression (12 failures)

- **File:** `src/tests/item-property-save-round-trip.test.ts`
- **Symptoms:** Saved GFF fields are empty; `PropertyName`, `Subtype`, `CostTable`, `CostValue`, `Param1`, `Param1Value`, `ChanceAppear`, `UsesPerDay`, `Useable`, `UpgradeType` are not written. The cost-table lookup test also fails because the old error guard text was replaced.
- **Cause:** We chose PR #112's `ItemProperty.ts` save logic (using `getSaveValue`) over PR #111's version. The test expects PR #111's field-writing behavior.
- **Action:** Reconcile the `ItemProperty.ts` save logic with PR #111's tests. Either restore field writes or update the tests to the new save format. Ensure a full round-trip preserves all fields.
- **Verify:** `npx jest src/tests/item-property-save-round-trip.test.ts --runInBand`

### 1.2 NWScript inheritance test broken by modular architecture (1 failure)

- **File:** `src/tests/nwscript/inheritK1Actions.test.ts`
- **Symptom:** Expects >700 actions in `NWScriptDefK1.Actions` / `K2.Actions`, receives 0. The merged stubs no longer expose populated tables.
- **Cause:** PR #112 replaced the monolithic tables with `buildReconciledActionMap("kotor"/"tsl")` stubs. PR #110's test reads the old tables directly.
- **Action:** Either (a) adapt the test to call `buildReconciledActionMap("kotor")` and `buildReconciledActionMap("tsl")` and verify name collisions at IDs 768–771, or (b) remove the test if the new variant-resolution architecture makes inheritance-by-name obsolete. Document the decision.
- **Verify:** `npx jest src/tests/nwscript/inheritK1Actions.test.ts --runInBand`

### 1.3 Forge TypeScript compile errors (6 suites)

- **Files:**
  - `src/apps/forge/dlg/dlgLocString.ts` — `Cannot find name 'ForgeDLGNode'`
  - `src/apps/forge/ProjectFileSystem.ts` — `Expected 2 arguments, but got 3` on `fs.rmdir`
  - `src/apps/forge/txi/txiSchema.ts` — `kind: string` not assignable to `TxiCompletionKind`
  - Missing module `@/apps/forge/lip/lipVisemes`
- **Action:** Fix the source type errors (rename `ForgeDLGNode` to `ForgeDLG` or add the type; update `fs.rmdir` for the Node 24 API; type the TXI completions; restore or stub the lip visemes module). Determine which errors are pre-existing vs merge-introduced; fix both.
- **Verify:** `npx tsc --noEmit -p tsconfig.json` and the affected suites.

### 1.4 NWScript decompiler integration tests (6 failures)

- **File:** `src/tests/nwscript/decompiler/NWScriptDecompiler.integration.test.ts`
- **Symptom:** Expected NSS signatures (e.g., `float sub1(float floatParam1)`) are not present in decompiled output. Likely due to action map / instruction set changes in PR #112.
- **Action:** Update the decompiler to handle the new action metadata or update expected outputs. Check `src/nwscript/NWScriptInstructionSet.ts` and `routineMetadata.ts` changes.
- **Verify:** `npx jest src/tests/nwscript/decompiler/NWScriptDecompiler.integration.test.ts --runInBand`

## Phase 2 — Validation (Priority: High)

### 2.1 Full test suite green
Run `npx jest --runInBand --no-cache ./src/tests` and require 0 failures.

### 2.2 Type check
Run `npx tsc --noEmit -p tsconfig.json` (or the project's build tsconfig) and require 0 errors.

### 2.3 Production build
Run `npm run webpack:prod` (or `npm run electron:build` if feasible) and verify success.

### 2.4 Smoke test (if assets available)
If a legal KotOR install is available in the environment, launch the Electron app (`npm start`) and reach the main menu. Note: game assets are not bundled; this may be a blocker.

## Phase 3 — Merge Refinement & Documentation (Priority: Medium)

### 3.1 Audit conflict resolutions
Review the 14 manually resolved files for correctness, especially:
- `ModuleCreature.ts` (save fields, `clampShort`, `getCommandable`, skill list handling)
- `CharGenMain.ts` / `CharGenCustomPanel.ts` / `CharGenQuickOrCustom.ts` (chargen refactor vs inline listeners)
- `ModuleStore.ts` (blueprint loading logic)
- `ItemProperty.ts` (save field names and cost table guard)
Document any remaining TODOs or behavioral differences.

### 3.2 Update docs
Reconcile `docs/port/*` with the merged code. Ensure the port's status/validation docs reflect the new test results.

### 3.3 Push and propose decomposition
Push `merged-all-prs` to `origin` (the fork). Optionally open a draft PR against `KobaltBlu/KotOR.js` or provide a decomposition plan (PR #112's author requested this).

## Phase 4 — Functional Validation (Priority: Medium, blocked on assets)

### 4.1 Endar Spire → Taris playthrough
PR #112 states a complete playthrough has not been repeated. If game assets are available, run the Electron app and validate:
- New game → Endar Spire → Taris
- Save/load round-trip in multiple modules
- Chargen (custom path) in K1 and TSL

### 4.2 TSL early-game validation
PR #112 includes early TSL work but no complete TSL support claim. Validate Peragus/early TSL modules if assets exist.

## Success Criteria

- All 60 test suites pass (or documented, accepted skips).
- TypeScript compilation clean.
- Production build succeeds.
- Conflict-resolution audit completed with no known regressions.
- Branch pushed to fork; decomposition/PR plan documented.

## Blockers & Unknowns

- **Game assets:** No KotOR installation is present in the environment. Playthrough validation is blocked until assets are supplied.
- **Node version:** Node 24 may expose deprecated `fs.rmdir` signatures; the Forge error suggests a compatibility fix is needed.
- **Draft PR scope:** PR #112 is explicitly not merge-ready. Upstream may reject a monolithic merge; decomposition into smaller PRs is advisable.
