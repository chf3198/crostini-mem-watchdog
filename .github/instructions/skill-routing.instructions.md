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
6. After any PR merge or deployment that changes user-facing behavior, complete the
   post-merge governance checklist before ending the task:
   - Update CHANGELOG for all shipped behavioral changes
   - Sync README/docs to reflect new behavior
   - Run `repo-profile-governance` to audit community health and metadata
   - Run `docs-drift-maintenance` to detect stale documentation
   - Add learnings entry if a significant discovery was made
   - If the merge changes extension behavior, run `release-version-integrity` to
       validate tag/manifest/changelog alignment, then publish the new version
    - Run `bash scripts/release-integrity-check.sh --post-publish` and require:
       - package.json version == Marketplace version
       - git tag exists for package version
       - GitHub release object exists for the tag
