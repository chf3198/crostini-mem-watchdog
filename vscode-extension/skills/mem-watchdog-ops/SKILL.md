---
name: mem-watchdog-ops
description: Operate and tune Crostini Mem Watchdog for low-memory development sessions. Use for status triage, log interpretation, and safe threshold tuning.
argument-hint: "[goal: status|logs|tune|preflight] [profile: balanced|conservative|playwright]"
user-invocable: true
disable-model-invocation: false
---

# Mem Watchdog Ops Skill

Use this skill when working in constrained Crostini environments where VS Code, Chrome/Playwright, and extension host memory spikes can trigger OOM.

## Ground Rules

- Never read or reason from `SwapFree` values on Crostini.
- Prefer `systemctl --user` only.
- Treat Mem Watchdog daemon as independent runtime authority.
- For tuning, use extension settings (`memWatchdog.*`) so the extension writes config and restarts service safely.

## Fast Workflows

1. **Status snapshot**
   - Use chat participant command: `/memwatchdog status`
   - Or run helper: `~/.copilot/skills/mem-watchdog-ops/watchdog-snapshot.sh`

2. **Recent actions / diagnosis**
   - `/memwatchdog logs`
   - Look for action markers in journal:
     - `ACTION(SIGTERM):`
     - `ACTION(SIGKILL):`
     - `RECOVERY(SIGTERM):`

3. **Apply tuning profile**
   - `/memwatchdog tune balanced`
   - `/memwatchdog tune conservative`
   - `/memwatchdog tune playwright`

4. **Manual protective action**
   - `/memwatchdog act kill chrome`
   - `/memwatchdog act restart service`

## Tuning Guidance

- **balanced**: general dev use
- **conservative**: earlier intervention, safer on tight RAM
- **playwright**: more headroom for automation sessions

When recommending profile changes, explain expected trade-off between stability and interruption frequency.

## Key Repo References

- [Daemon logic](../../../mem-watchdog.sh)
- [Extension activation + polling](../../../extension.js)
- [Dashboard/actions](../../../commands.js)
- [Config bridge](../../../configWriter.js)
