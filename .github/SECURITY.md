# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.3.x (latest) | ✅ |
| < 0.3.0 | ❌ |

Only the latest published release receives security fixes.

---

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email: **curtisfranks@gmail.com**  
Subject line: `[mem-watchdog] Security: <one-line summary>`

Include:
- A description of the vulnerability and its impact
- Steps to reproduce (or a proof-of-concept)
- The version affected
- Your suggested fix (optional but appreciated)

You will receive an acknowledgement within 72 hours and a resolution timeline
within 7 days. If you do not receive a response, follow up by opening a GitHub
issue with the title `[Security] Follow-up` (no vulnerability details in the
public issue).

---

## Scope

### In scope

- **`mem-watchdog.sh`** — the daemon process; runs as a systemd user unit
- **`vscode-extension/`** — the VS Code extension that installs and configures the daemon
- **`install.sh`** — the installer script

### Out of scope

- Issues in VS Code itself, Chromium, or the Crostini/Linux container environment
- Issues that require physical access to the machine
- Theoretical weaknesses with no practical exploit path on the target platform
  (Chromebook running Crostini, Debian 12, non-root container)

---

## Security Context

Understanding the privilege model helps scope reports accurately.

### Daemon privilege model

The daemon (`mem-watchdog.sh`) runs as a **systemd user unit** (`systemctl --user`),
not a system unit. It operates with the same UID as the logged-in user.
The container runs non-root (`CapEff=0` — no Linux capabilities).

**`oom_score_adj` writes:** The daemon writes to `/proc/<PID>/oom_score_adj`
for processes it owns. Writing non-negative values (0 to 1000) to your own
processes requires no special privilege. The daemon never attempts to write
negative values (which would require `CAP_SYS_RESOURCE`).

**No `sudo` in the daemon.** All kill operations use `pkill` as the current
user. The daemon cannot kill processes owned by other users or root.

### Extension privilege model

The VS Code extension runs in the VS Code extension host process (Electron /
Node.js) with the same UID as the user. It:
- Writes to `~/.local/bin/mem-watchdog.sh` (user-owned)
- Writes to `~/.config/mem-watchdog/config.sh` (user-owned)
- Calls `systemctl --user` to start/stop/enable the service

The extension does **not** request elevated privileges.

### `install.sh`

`install.sh` does not use `sudo`. All writes are to `~/.local/bin/` and
`~/.config/systemd/user/` (both user-owned).

---

## Known Limitations

These are acknowledged design constraints, not vulnerabilities:

- **Polling interval:** The daemon checks every 2 seconds (0.5 s in startup mode).
  A sufficiently rapid memory spike (> ~4 GB/s) may outpace the watchdog.
  This is a fundamental limitation of a polling architecture. See
  `docs/technical/system-stability.md §8` for the confirmed worst-case timing.

- **`SwapFree` overflow sentinel:** The Crostini kernel reports
  `SwapFree: 18446744073709551360 kB` (uint64 overflow). The daemon intentionally
  never reads this field. Any contributed code that reads `SwapFree` will be
  rejected — it is not a security issue but a correctness issue specific to this
  platform.

- **Commercial deployments:** The license is
  [PolyForm Noncommercial](../LICENSE). If you are deploying this in a commercial
  context and discover a security issue, please report it via the email above.
  Commercial licensing enquiries can be directed to the same address.
