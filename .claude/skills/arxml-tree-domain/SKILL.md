---
name: arxml-tree-domain
description: Modify ARXML parsing, tree providers, and hover navigation. Use for changes in `src/arxmlParser.ts`, `src/treeProvider.ts`, `src/integratedTreeProvider.ts`, `src/crossFileSearchProvider.ts`, or `src/hoverProvider.ts`.
compatibility: Requires VS Code API types and SAX parser usage.
---

Use this skill for ARXML parsing and navigation logic.

Core files
- `src/arxmlParser.ts`: streaming SAX parsing into `ArxmlNode` tree.
- `src/treeProvider.ts`: tree providers, bookmarks, indexing, and navigation.
- `src/integratedTreeProvider.ts`: combined Filter/View controls with tree UI.
- `src/crossFileSearchProvider.ts`: workspace-wide filtering engine and cache.
- `src/hoverProvider.ts`: hover detection and link creation.
- `src/arxmlNode.ts`: core node shape and equality.

Guidelines
- Keep parsing streaming; avoid full DOM parsing.
- Preserve cross-file navigation by indexing open documents.
- Use `ArxmlNode` consistently and keep ranges accurate.
- Filter modes can be per-field (`nameMode`, `arpathMode`, `elementMode`) and fall back to `mode`.
- Handle errors with `vscode.window.showErrorMessage(...)`.
- Avoid refactors when fixing a specific bug.
- Keep SOLID and DRY principles in design, implementation, and documentation.

Indexing behavior
- `ArxmlTreeProvider` rebuilds an ARPATH index for quick lookup.
- `findNodeWithArPath` uses index, tree walk, then text search fallback.

Testing
- Add tests in `src/test/extension.test.ts` using Mocha `suite`/`test`.
- Use in-memory samples and `createPositionResolver` pattern.
