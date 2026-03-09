---
name: Bug report
about: Something isn't working as expected in the daemon or extension
title: "[Bug] "
labels: bug
assignees: chf3198
---

## Environment

- **ChromeOS version**: <!-- e.g. 130.0.6723.118 -->
- **Crostini kernel**: <!-- output of: uname -r -->
- **VS Code version**: <!-- e.g. 1.108.0 -->
- **Extension version**: <!-- shown in Extensions panel, e.g. 0.3.1 -->
- **Free RAM at time of issue**: <!-- output of: free -h -->

## Checklist before submitting

- [ ] `systemctl --user status mem-watchdog` shows `active (running)`
- [ ] `earlyoom` is NOT installed and running (it crash-loops on Crostini — see README)
- [ ] `/proc/meminfo` does NOT contain `SwapFree: 18446744073709551360 kB` as the only
      symptom (that value is normal on Crostini; the daemon ignores it by design)

## What happened

<!-- Describe what you observed. -->

## What you expected

<!-- Describe what you expected to happen. -->

## Journal output

Paste the last 50 lines from the watchdog journal. Run:
```bash
journalctl --user -u mem-watchdog --since "1 hour ago" --no-pager
```

<details>
<summary>Journal output</summary>

```
(paste here)
```

</details>

## Memory snapshot at time of issue

Paste the output of:
```bash
free -h && echo "---" && ps -C code -o pid=,rss=,comm= | sort -k2 -rn | head -10
```

<details>
<summary>Memory snapshot</summary>

```
(paste here)
```

</details>

## Additional context

<!-- Any other relevant information: Chrome tabs open, Playwright running, etc. -->
