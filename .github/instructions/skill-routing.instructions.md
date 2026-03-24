---
applyTo: "**"
---

Use repository and global customization layers together for every task:

1. Read .github/copilot-instructions.md first.
2. Apply nearest AGENTS.md instructions.
3. Prefer reusable global skills from ~/.copilot/skills before ad-hoc reasoning.
4. For repository workflow routing, invoke:
   - `repo-standards-router` first
   - `workflow-self-anneal` only for post-failure/process drift checks
5. Do not claim skill usage unless the skill was actually invoked and followed.
