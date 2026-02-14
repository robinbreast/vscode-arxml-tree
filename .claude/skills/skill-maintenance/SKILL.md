---
name: skill-maintenance
description: Maintain and evolve local Agent Skills for this repo. Use after implementing features or changing workflows so skills stay current.
compatibility: Requires access to this repository's [`.claude/skills/`](../) directory.
---

Use this skill whenever new features, workflows, or tooling are added.

Base specification
- The authoritative base specification for skill maintenance is [Agent Skills Specification](https://agentskills.io/specification).
- If local guidance and the specification differ, align the skill with the specification unless the repo has an explicit, documented exception.

Maintenance rules
1. Update the most relevant existing skill when behaviors change.
2. Add a new skill only if the change introduces a new domain.
3. Keep [`SKILL.md`](SKILL.md) frontmatter valid and matching directory name.
4. Keep skill instructions concise and task-focused.
5. Avoid duplicating [`AGENTS.md`](../../../AGENTS.md); reference it if needed.
6. Keep SOLID and DRY principles in design, implementation, and documentation.
7. Prefer single-source references:
   - [`package.json`](../../../package.json) for commands/settings
   - [`AGENTS.md`](../../../AGENTS.md) for shared conventions
   - [`README.md`](../../../README.md) for user-facing behavior
8. Think and design first before implementation; define structure and ownership before editing skill docs.
9. All source-file and documentation references in markdown docs/skills must use markdown links.
10. Keep skill structure and frontmatter compliant with [Agent Skills Specification](https://agentskills.io/specification) (name/description constraints, optional fields, and directory conventions).
11. Prefer progressive disclosure from the specification: keep [`SKILL.md`](SKILL.md) concise and place detailed material in `references/` when needed.
12. Use relative paths for in-skill file links as defined by [File references](https://agentskills.io/specification#file-references).

Consistency checklist
- Skill name: lowercase, hyphenated, 1-64 chars.
- Description: clear when-to-use guidance (1-1024 chars).
- Compatibility: only if environment constraints matter.
- Structure: [`.claude/skills/<skill-name>/SKILL.md`](../).

Update triggers
- New build/test commands.
- New components/modules with unique workflows.
- New repo-specific patterns or constraints.

Quality gates
- No outdated paths or commands.
- Instructions align with current codebase conventions.
- Skills avoid heavy refactors and keep steps minimal.
- Skills remain compliant with [Agent Skills Specification](https://agentskills.io/specification).
