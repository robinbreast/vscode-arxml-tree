---
name: vscode-extension-workflow
description: Build, lint, test, and package this VS Code extension. Use when changing extension commands, activation, packaging, or build/test scripts.
compatibility: Requires Node.js, npm, and VS Code extension tooling.
---

Use this skill when working on workflows or commands for this repo's VS Code extension.

Shared conventions
- Follow [`AGENTS.md`](../../../AGENTS.md) for coding style, TypeScript/lint rules, testing conventions, and shared engineering constraints.
- Keep this skill focused on workflow/packaging/command concerns.

Key files
- [`package.json`](../../../package.json) for scripts, activation events, and contributions.
- [`src/extension.ts`](../../../src/extension.ts) for activation and command wiring.
- [`src/integratedTreeProvider.ts`](../../../src/integratedTreeProvider.ts) for Filter/View controls tree UI.
- [`src/searchViewProvider.ts`](../../../src/searchViewProvider.ts) for webview-side filter/search/history interactions.
- [`README.md`](../../../README.md) for user-visible docs and command lists.
- [`eslint.config.js`](../../../eslint.config.js) for ESLint 9 flat-config rules.

Commands
- Install deps: `npm install`
- Bundle (dev): `npm run esbuild`
- Bundle (minified): `npm run vscode:prepublish`
- Type check: `npm run compile`
- Lint: `npm run lint`
- Tests: `npm test`

Single test
- Prefer VS Code Testing view; tests live in [`src/test/extension.test.ts`](../../../src/test/extension.test.ts).
- CLI: `npm test -- --grep "<test name substring>"`.

Workflow checklist
1. Update [`package.json`](../../../package.json) commands or contributions as needed.
2. Keep [`README.md`](../../../README.md) in sync with new commands or settings.
3. Avoid editing generated output in `out/` or `dist/`.
4. Match existing TypeScript style and ESLint rules.
5. Run `npm run compile`, `npm run lint`, and `npm test` after changes when feasible.
6. Keep docs DRY: reference [`package.json`](../../../package.json) as command/settings source of truth.
7. Think and design first before implementation; decide workflow impacts before changing scripts/contributions.
8. Always apply SOLID and DRY principles when changing extension workflow behavior.
9. Avoid unnecessary refactors of scripts/contributions; keep workflow edits minimal and focused.

Feature/workflow hotspots
- Filter controls now support per-field modes (Contains/Regex/Glob) and recent-filter operations.
- Custom view flows include select/apply/toggle/import/export plus workspace/global storage scope.
- Performance behavior includes `refreshMode`, `debounceDelay`, and `adaptiveDebounce` settings.
- Search and saved filters use persistent stores (`SearchHistoryStore`, `SavedFiltersStore`).

Gotchas
- The extension activates on `onLanguage:arxml`.
- Additional activation occurs for views (`arxml-integrated-view`, `bookmark-tree-view`).
- ESLint uses flat config ([`eslint.config.js`](../../../eslint.config.js)), not legacy eslintrc files.
- Tests are Mocha-based and executed via the VS Code test runner.
