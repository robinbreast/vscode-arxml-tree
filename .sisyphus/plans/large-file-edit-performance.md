# Large File Edit Performance Improvements

## TL;DR

> **Quick Summary**: Reduce keystroke-cost in large ARXML files by making refresh behavior configurable and incrementally updating the ARPATH index and filtered roots, while keeping defaults close to current behavior.
> 
> **Deliverables**: 
> - New settings for refresh mode and debounce behavior
> - Incremental ARPATH index + filtered root updates (avoid full rebuilds per edit)
> - Adaptive debounce for large documents
> - Updated documentation and tests
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 → Task 2 → Task 4 → Task 5 (with Task 3 in parallel but required before final tests)

---

## Context

### Original Request
"I’m wondering if frequent edits in large file cause performance issue with this extension." → "want to apply both low risk and performance benefit"

### Interview Summary
**Key Discussions**:
- Apply low-risk improvements plus tangible performance wins.
- Keep current on-change behavior as default, but allow on-save/manual modes.
- Add adaptive debounce for large files; expose settings.
- Tests after implementation (Mocha) with targeted manual verification.

**Research Findings**:
- Tree refresh debounced at 200ms; filter debounce 300ms (`src/treeProvider.ts`, `src/optimizedTreeProvider.ts`).
- Parsing is streaming; large-tree optimization triggers at 1000+ nodes (`src/arxmlParser.ts`, `src/treeProvider.ts`).
- `parseDocuments` already skips unchanged docs; hot path cost is full `rebuildArpathIndex()` + `rebuildFilteredRoots()` on any change (`src/treeProvider.ts`).
- Hover uses `findNodeWithArPath()` which force-parses open docs (`src/hoverProvider.ts`).
- No performance settings exist in `package.json`.

### Metis Review
**Identified Gaps** (addressed in plan):
- Incremental index should replace full `rebuildArpathIndex()` on edits.
- Define hover + selection-sync behavior for on-save/manual modes.
- Ensure filtered roots update only for changed documents.
- Avoid changes to parser/optimized provider/cross-file search cache.

---

## Work Objectives

### Core Objective
Reduce UI lag during frequent edits in large ARXML files by limiting expensive per-keystroke work while preserving navigation accuracy.

### Concrete Deliverables
- Settings: `arxmlTree.refreshMode`, `arxmlTree.debounceDelay`, `arxmlTree.adaptiveDebounce`.
- Incremental ARPATH index updates per changed document.
- Incremental filtered root rebuilds per changed document.
- Adaptive debounce tied to file size or node count threshold.
- Updated README documentation for new settings.
- Tests for settings and incremental behavior.

### Definition of Done
- [x] New settings appear in `package.json` and README.
- [x] Edits only re-index changed document(s), not all open ARXML files.
- [x] Refresh mode on-save/manual behaves as defined (see Decision Needed).
- [x] `npm run compile`, `npm run lint`, `npm test` all pass.

### Must Have
- No worker threads or new dependencies.
- Defaults preserve current behavior (on-change refresh).
- Incremental index + filtered root updates for changed docs.

### Must NOT Have (Guardrails)
- No changes to SAX parsing logic (`src/arxmlParser.ts`).
- No changes to optimized tree provider internals (`src/optimizedTreeProvider.ts`).
- No changes to cross-file search cache behavior (`src/crossFileSearchProvider.ts`).
- No settings for internal thresholds (e.g., `CHUNK_SIZE`, `LARGE_TREE_THRESHOLD`).

---

## Verification Strategy (MANDATORY)

### Test Decision
- **Infrastructure exists**: YES (Mocha via `npm test`)
- **User wants tests**: Tests-after
- **Framework**: Mocha / vscode-test

### Tests-After Workflow
- Implement changes first.
- Add/adjust tests in `src/test/*.test.ts`.
- Run: `npm run compile && npm run lint && npm test`.

---

## Execution Strategy

### Parallel Execution Waves

Wave 1 (Start Immediately):
├── Task 1: Add settings schema + README updates
└── Task 3: Incremental ARPATH index + filtered root updates

Wave 2 (After Wave 1):
├── Task 2: Refresh mode + adaptive debounce wiring
└── Task 4: Hover + selection-sync behavior alignment (Decision Needed)

Wave 3 (After Wave 2):
└── Task 5: Tests and verification

Critical Path: Task 1 → Task 2 → Task 4 → Task 5
Parallel Speedup: ~30–40%

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|----------------------|
| 1 | None | 2 | 3 |
| 2 | 1 | 4, 5 | 3 |
| 3 | None | 5 | 1 |
| 4 | 2 | 5 | None |
| 5 | 2, 3, 4 | None | None |

---

## TODOs

- [x] 1. Add refresh settings schema + document in README

  **What to do**:
  - Add `arxmlTree.refreshMode` (enum: `onChange`, `onSave`, `manual`; default `onChange`).
  - Add `arxmlTree.debounceDelay` (number; default 200ms).
  - Add `arxmlTree.adaptiveDebounce` (boolean; default true).
  - Update README to explain settings and tradeoffs (stale hover in on-save/manual if applicable).

  **Must NOT do**:
  - Do not add settings for `CHUNK_SIZE`, `LARGE_TREE_THRESHOLD`, or parser internals.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small configuration + doc updates.
  - **Skills**: `design-implementation`, `vscode-extension-workflow`
    - `design-implementation`: Align settings with existing extension patterns.
    - `vscode-extension-workflow`: Ensure config/schema changes fit extension packaging.
  - **Skills Evaluated but Omitted**:
    - `arxml-tree-domain`: Not needed for config-only changes.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 3)
  - **Blocks**: Task 2
  - **Blocked By**: None

  **References**:
  - `package.json:470-483` - Current configuration schema location.
  - `README.md` - Update settings/performance section to reflect new options.
  - `src/extension.ts:68-73` - Refresh commands exist; ensure docs mention manual refresh command.

  **Acceptance Criteria**:
  - [x] `node -e "const p=require('./package.json');console.log(Object.keys(p.contributes.configuration.properties).filter(k=>k.startsWith('arxmlTree.')).join('\n'))"` includes the three new settings.
  - [x] README contains a section describing `arxmlTree.refreshMode`, `arxmlTree.debounceDelay`, `arxmlTree.adaptiveDebounce`.

- [x] 2. Implement refresh mode + adaptive debounce behavior

  **What to do**:
  - Read settings inside `onDidChangeTextDocument` / `scheduleRefresh` so changes take effect immediately.
  - If `refreshMode === 'onChange'`, keep current behavior (debounced).
  - If `refreshMode === 'onSave'`, skip refresh on edit; trigger refresh on save instead.
  - If `refreshMode === 'manual'`, only refresh via existing refresh commands.
  - Add adaptive debounce: increase delay for large documents (tie to node count or size; default threshold: `LARGE_TREE_THRESHOLD`).
  - Ensure `parsePromise` race is handled (if a refresh was skipped because a parse was in progress, schedule a follow-up refresh).

  **Must NOT do**:
  - Do not change SAX parser behavior or optimized tree provider internals.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Core runtime behavior changes in tree provider.
  - **Skills**: `arxml-tree-domain`, `design-implementation`
    - `arxml-tree-domain`: Knowledge of tree provider and ARXML parsing flow.
    - `design-implementation`: Safe refactor of refresh lifecycle.
  - **Skills Evaluated but Omitted**:
    - `vscode-extension-workflow`: Not needed unless running builds.

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 4, Task 5
  - **Blocked By**: Task 1

  **References**:
  - `src/treeProvider.ts:74-83` - onDidChangeTextDocument handler.
  - `src/treeProvider.ts:356-365` - `scheduleRefresh` debounce pattern.
  - `src/treeProvider.ts:367-397` - `rebuildTree` orchestration + parsePromise guard.
  - `src/treeProvider.ts:98-129` - selection sync logic (may need mode-aware behavior).
  - `package.json:470-483` - settings schema used by configuration.

  **Acceptance Criteria**:
  - [x] With `refreshMode=manual`, edits do not call `rebuildTree` until `ARTree: Refresh` is invoked.
  - [x] With `refreshMode=onSave`, edits do not refresh; saving triggers refresh.
  - [x] Adaptive debounce uses larger delay for documents over the threshold.

- [x] 3. Incremental ARPATH index + filtered root updates per changed document

  **What to do**:
  - Change `parseDocuments` to return a `Set<string>` of changed document URIs.
  - Track per-document index keys (e.g., `docArpathKeys: Map<string, Set<string>>`).
  - Implement `removeDocumentFromIndex(uri)` and `indexDocument(uri)`.
  - On successful parse, remove old keys and add new keys for that document only.
  - Update `rebuildTree()` to only update index + filtered roots for changed URIs.
  - Keep `rebuildArpathIndex()` for full rebuild (initial load/manual refresh).

  **Must NOT do**:
  - Do not modify `parseArxmlDocument` or change `ArxmlNode` interface shape.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Core indexing behavior with correctness implications.
  - **Skills**: `arxml-tree-domain`
    - `arxml-tree-domain`: Directly modifies tree/index logic.
  - **Skills Evaluated but Omitted**:
    - `design-implementation`: Not critical once patterns are clear.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Task 5
  - **Blocked By**: None

  **References**:
  - `src/treeProvider.ts:446-493` - `parseDocuments` current signature + behavior.
  - `src/treeProvider.ts:495-607` - `rebuildArpathIndex` + `indexTree` implementation.
  - `src/treeProvider.ts:609-631` - `rebuildFilteredRoots` / `rebuildFilteredRootForDocument`.
  - `src/treeProvider.ts:738-754` - `buildArpathVariants` multiplies index size.

  **Acceptance Criteria**:
  - [x] Editing a single ARXML file updates index entries only for that file (no full index rebuild).
  - [x] Filtered roots update only for changed documents.
  - [x] Failed parse does not drop prior index entries for that document.

- [x] 4. Implement hover + selection-sync behavior under on-save/manual modes

  **What to do**:
  - When `refreshMode` is `onSave` or `manual`, hover + selection sync parse **only the active document**.
  - Cross-file hover uses the stale index until a manual refresh or save occurs.
  - Document the behavior in the setting description and README.

  **Must NOT do**:
  - Do not remove hover functionality or focus-sync feature.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: User-visible behavior with correctness tradeoffs.
  - **Skills**: `arxml-tree-domain`
    - `arxml-tree-domain`: Touches hover + tree provider behavior.
  - **Skills Evaluated but Omitted**:
    - `writing`: Not sufficient without code changes.

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 5
  - **Blocked By**: Task 2

  **References**:
  - `src/hoverProvider.ts:8-28` - Hover lookup via `findNodeWithArPath`.
  - `src/treeProvider.ts:98-129` - Selection sync → `getDocumentRoot()`.
  - `src/treeProvider.ts:399-425` - `ensureAllDocumentsParsed` behavior.

  **Acceptance Criteria**:
  - [x] In on-save/manual mode, hover + selection sync trigger parsing only for the active document.
  - [x] Hover still returns a result (or explicitly notes stale data) without throwing errors.

- [x] 5. Add tests + verification for settings and incremental behavior

  **What to do**:
  - Add a test suite in `src/test/extension.test.ts` for refresh settings + debounce logic.
  - Add tests verifying `parseDocuments` returns changed URIs (not boolean) and index updates are incremental.
  - Update any existing tests impacted by signature changes.

  **Must NOT do**:
  - Do not add new test frameworks or dependencies.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Tests must align with VS Code test harness and existing patterns.
  - **Skills**: `vscode-extension-workflow`, `design-implementation`
    - `vscode-extension-workflow`: Test harness knowledge and run commands.
    - `design-implementation`: Test design for incremental behavior.
  - **Skills Evaluated but Omitted**:
    - `arxml-tree-domain`: Optional; tests can be black-box.

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: None
  - **Blocked By**: Task 2, Task 3, Task 4

  **References**:
  - `src/test/extension.test.ts` - Existing parser + tree provider tests.
  - `src/test/crossFileSearchProvider.test.ts` - Example of async file-based tests.
  - `package.json:486-497` - Test scripts and pretest flow.

  **Acceptance Criteria**:
  - [x] `npm run compile` exits 0.
  - [x] `npm run lint` exits 0.
  - [x] `npm test` passes with new settings/refresh tests.
  - [x] `node -e "const p=require('./package.json');const props=p.contributes.configuration.properties;console.log(['arxmlTree.refreshMode','arxmlTree.debounceDelay','arxmlTree.adaptiveDebounce'].every(k=>k in props))"` prints `true`.

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1-2 | `feat(perf): add refresh mode settings` | package.json, README.md, src/treeProvider.ts | npm run compile |
| 3 | `perf(index): incrementally rebuild arpath index` | src/treeProvider.ts | npm test -- --grep "ARXML Parser" |
| 4-5 | `test(perf): cover refresh modes` | src/test/extension.test.ts | npm test |

---

## Success Criteria

### Verification Commands
```bash
npm run compile
npm run lint
npm test
```

### Final Checklist
- [x] Settings schema + docs updated.
- [x] Incremental index + filtered roots reduce per-edit work.
- [x] Refresh mode behaviors match chosen policy.
- [x] All tests pass.
