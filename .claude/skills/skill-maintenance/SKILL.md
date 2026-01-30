---
name: skill-maintenance
description: Maintain and evolve local Agent Skills for this repo. Use after implementing features or changing workflows so skills stay current.
compatibility: Requires access to this repository's `.claude/skills/` directory.
---

Use this skill whenever new features, workflows, or tooling are added.

Maintenance rules
1. Update the most relevant existing skill when behaviors change.
2. Add a new skill only if the change introduces a new domain.
3. Keep `SKILL.md` frontmatter valid and matching directory name.
4. Keep skill instructions concise and task-focused.
5. Avoid duplicating `AGENTS.md`; reference it if needed.
6. Keep SOLID and DRY principles in design, implementation, and documentation.

Consistency checklist
- Skill name: lowercase, hyphenated, 1-64 chars.
- Description: clear when-to-use guidance (1-1024 chars).
- Compatibility: only if environment constraints matter.
- Structure: `.claude/skills/<skill-name>/SKILL.md`.

Update triggers
- New build/test commands.
- New components/modules with unique workflows.
- New repo-specific patterns or constraints.

Quality gates
- No outdated paths or commands.
- Instructions align with current codebase conventions.
- Skills avoid heavy refactors and keep steps minimal.
