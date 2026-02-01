---
name: vscode-extension-workflow
description: Build, lint, test, and package this VS Code extension. Use when changing extension commands, activation, packaging, or build/test scripts.
compatibility: Requires Node.js, npm, and VS Code extension tooling.
---

Use this skill when working on workflows or commands for this repo's VS Code extension.

Key files
- `package.json` for scripts, activation events, and contributions.
- `src/extension.ts` for activation and command wiring.
- `src/integratedTreeProvider.ts` for Filter/View controls tree UI.
- `README.md` for user-visible docs and command lists.

Commands
- Install deps: `npm install`
- Bundle (dev): `npm run esbuild`
- Bundle (minified): `npm run vscode:prepublish`
- Type check: `npm run compile`
- Lint: `npm run lint`
- Tests: `npm test`

Single test
- Prefer VS Code Testing view; tests live in `src/test/extension.test.ts`.
- CLI: `npm test -- --grep "<test name substring>"`.

Workflow checklist
1. Update `package.json` commands or contributions as needed.
2. Keep `README.md` in sync with new commands or settings.
3. Avoid editing generated output in `out/` or `dist/`.
4. Match existing TypeScript style and ESLint rules.
5. Run `npm run compile` and `npm test` after changes when feasible.
6. Keep SOLID and DRY principles in design, implementation, and documentation.

Gotchas
- The extension activates on `onLanguage:arxml`.
- Tests are Mocha-based and executed via the VS Code test runner.
