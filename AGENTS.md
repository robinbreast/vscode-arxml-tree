# AGENTS.md

This file guides agentic coding assistants working in this repo.

Repository
- VS Code extension for ARXML tree navigation.
- Main code in `src/`, compiled output in `out/`.

Quick Start
- Install deps: `npm install`
- Build bundle: `npm run esbuild`
- TypeScript compile: `npm run compile`

Build, Lint, Test
- Bundle (minified): `npm run vscode:prepublish`
- Bundle (dev): `npm run esbuild`
- Bundle (watch): `npm run esbuild-watch`
- Type check: `npm run compile`
- Type check (watch): `npm run watch`
- Lint: `npm run lint`
- Tests: `npm test`

Run a Single Test
- Preferred: VS Code Testing view (see `vsc-extension-quickstart.md`).
- CLI (Mocha grep): `npm test -- --grep "<test name substring>"`
- Single file (Mocha): `npm test -- --grep "<suite name>"` and keep tests in `src/test/extension.test.ts`.

Debugging
- Use VS Code launch config and press `F5`.
- Keep `npm run watch` running when iterating locally.

Generated/Build Artifacts
- `out/` is generated (tsc/esbuild). Do not edit by hand.
- `dist/` is ignored by ESLint; treat as generated output.

Code Style (Observed)
- Language: TypeScript with `strict` enabled (`tsconfig.json`).
- Imports: `import * as vscode from 'vscode';` for VS Code API.
- Relative imports use `./` and `../` (no path aliases).
- Quotes: single quotes in TS source.
- Semicolons are used; ESLint enforces `@typescript-eslint/semi` (warn).
- Curly braces required for control flow (`curly: warn`).
- Prefer `===`/`!==` (`eqeqeq: warn`).
- Do not `throw` literals; throw `Error` instances (`no-throw-literal: warn`).

Formatting
- No formatter config found; follow the file you edit.
- Indentation is mostly 2 spaces, but some files use 4 spaces (match existing style).
- Keep lines readable; use helper functions for complex logic.

Type Usage
- Keep explicit types for exported APIs and interfaces.
- Avoid `any` and implicit `any` in new code.
- Use `undefined` instead of `null` unless required by VS Code API.

Naming
- `camelCase` for variables/functions.
- `PascalCase` for classes/interfaces/types.
- `SCREAMING_SNAKE_CASE` for constants only when truly constant.
- Import naming: `camelCase` or `PascalCase` (per ESLint naming rule).

Error Handling
- Surface errors via VS Code UI when user-visible:
  - `vscode.window.showErrorMessage(...)`
- Handle expected failures locally; avoid empty `catch` blocks.
- Preserve error messages in promise chains (`catch(error => ...)`).

Testing Conventions
- Test framework: Mocha (see `src/test/extension.test.ts`).
- Use `suite` and `test` helpers from Mocha.
- Keep test fixtures inline when small; use helper functions for setup.

Repo-Specific Patterns
- Tree data providers implement `vscode.TreeDataProvider<T>` and may be disposable.
- ARXML parsing uses streaming SAX parser; avoid full DOM parsing.
- Cross-file navigation relies on open documents; keep index updates fast.

Docs to Keep in Sync
- If you add or change commands/settings, update `README.md`.
- Extension activation and contributions live in `package.json`.

Cursor/Copilot Rules
- No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` found.

Notes for Agents
- Read the target file first; follow local style.
- Prefer minimal, focused changes.
- Avoid refactors when making a small fix.
- Keep SOLID and DRY principles in design, implementation, and documentation.
