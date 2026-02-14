---
name: arxml-tree-domain
description: Modify ARXML parsing, tree providers, and hover navigation for this extension.
compatibility: Requires VS Code API types and SAX parser usage.
---

Use this skill for ARXML parsing, tree behavior, filtering/search, and navigation logic.

Shared conventions
- Follow [`AGENTS.md`](../../../AGENTS.md) for coding style, TypeScript/lint rules, testing conventions, and shared engineering constraints.
- Keep this skill focused on domain-specific ARXML/tree guidance only.

Core files
- [`src/arxmlParser.ts`](../../../src/arxmlParser.ts): streaming SAX parsing into `ArxmlNode` tree.
- [`src/arxmlNode.ts`](../../../src/arxmlNode.ts): core node shape and equality.
- [`src/treeProvider.ts`](../../../src/treeProvider.ts): tree provider, bookmarks, indexing, and navigation.
- [`src/integratedTreeProvider.ts`](../../../src/integratedTreeProvider.ts): integrated tree with filter/view controls.
- [`src/optimizedTreeProvider.ts`](../../../src/optimizedTreeProvider.ts): optimized rendering/filtering path for large trees.
- [`src/crossFileSearchProvider.ts`](../../../src/crossFileSearchProvider.ts): cross-file search and cached lookup.
- [`src/hoverProvider.ts`](../../../src/hoverProvider.ts): hover detection and goto-link creation.
- [`src/viewBehavior.ts`](../../../src/viewBehavior.ts): extensible node presentation/service-summary contracts.
- [`src/viewBehaviorRegistry.ts`](../../../src/viewBehaviorRegistry.ts): registration and lookup for view behaviors.
- [`src/cddViewBehavior.ts`](../../../src/cddViewBehavior.ts): CDD-specific behavior and diagnostic service summary.
- [`src/customViewStore.ts`](../../../src/customViewStore.ts): custom view persistence and storage scope handling.
- [`src/customViewTreeProvider.ts`](../../../src/customViewTreeProvider.ts): custom-view UI tree provider logic.
- [`src/searchViewProvider.ts`](../../../src/searchViewProvider.ts): webview messaging for filter/search/history/saved filters.
- [`src/searchHistoryStore.ts`](../../../src/searchHistoryStore.ts): persistent search history.
- [`src/savedFiltersStore.ts`](../../../src/savedFiltersStore.ts): persistent saved filters.

Guidelines
- Think and design first before implementation; validate scope and approach, then edit.
- Always apply SOLID and DRY principles when evolving workspace behavior.
- Keep parsing streaming; avoid full DOM parsing.
- Preserve cross-file navigation by indexing open documents.
- Use `ArxmlNode` consistently and keep ranges accurate.
- Keep filter-mode behavior consistent: per-field (`nameMode`, `arpathMode`, `elementMode`) falls back to `mode`.
- Keep view-behavior extensions behind `ViewBehavior`/registry abstractions.
- Maintain workspace/global storage scope behavior for custom views and persisted filters.
- Handle errors with `vscode.window.showErrorMessage(...)`.
- Avoid refactors when fixing a specific bug.

Indexing behavior
- `ArxmlTreeProvider` rebuilds an ARPATH index for quick lookup.
- `findNodeWithArPath` uses index, tree walk, then text search fallback.

Testing
- Add/update tests in:
  - [`src/test/extension.test.ts`](../../../src/test/extension.test.ts) for parser/tree/bookmark/performance behavior.
  - [`src/test/crossFileSearchProvider.test.ts`](../../../src/test/crossFileSearchProvider.test.ts) for workspace search behavior.
  - [`src/test/searchViewProvider.test.ts`](../../../src/test/searchViewProvider.test.ts) for webview message handling.
  - [`src/test/searchViewProvider.integration.test.ts`](../../../src/test/searchViewProvider.integration.test.ts) for integration message flow.
- Use in-memory ARXML samples and `createPositionResolver` pattern for parser tests.
