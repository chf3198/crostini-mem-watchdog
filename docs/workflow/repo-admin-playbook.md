# Repository Admin Playbook

This document defines the public contribution workflow for this repository.

## Goal

Any visitor should be able to answer:

- What is being worked on now?
- Why was a change made?
- Which ticket, milestone, and PR delivered it?

## Required workflow

1. Create or select an issue before implementation starts.
2. Apply labels:
   - one taxonomy label: `type: epic|research|task|bug-fix`
   - one priority label: `priority: critical|high|medium|low`
   - one or more domain labels: `policy|psi|cgroup|oom|crostini|testing|performance|research`
3. Assign milestone.
4. Add issue to project board.
5. Implement on a topic branch.
6. Open PR with `Closes #N`.
7. Merge only after gates and checklist pass.
8. Release/publish only after explicit client UAT PASS.

## Client role boundary

- Client participates only in:
  - design consultation
  - UAT
- All technical execution remains agent/contributor responsibility.

## Branch policy

- Never commit directly to `main`.
- Use `type/short-description`.
- One branch = one concern.

## Commit policy

Use:

`type(scope): description`

Examples:

- `fix(daemon): prevent kill-loop with cooldown`
- `docs(workflow): add issue taxonomy playbook`

## Required PR evidence

- Linked issue (`Closes #N`)
- Milestone
- Labels
- Gate suite results (`test-watchdog`, `bash -n`, `shellcheck`, `npm test`)
- Client UAT PASS recorded before release/publish

## Project references

- Roadmap project: https://github.com/users/chf3198/projects/2
- Issues: https://github.com/chf3198/crostini-mem-watchdog/issues
- Milestones: https://github.com/chf3198/crostini-mem-watchdog/milestones
