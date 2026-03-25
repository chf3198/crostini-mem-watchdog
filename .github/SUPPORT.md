# Support

## Getting Help

- **Bug reports & feature requests**: [Open an issue](https://github.com/chf3198/crostini-mem-watchdog/issues/new/choose) using the appropriate template.
- **Discussions**: Use [GitHub Issues](https://github.com/chf3198/crostini-mem-watchdog/issues) for questions — there is no separate Discussions forum at this time.
- **VS Code Marketplace**: If you installed via the [Marketplace](https://marketplace.visualstudio.com/items?itemName=CurtisFranks.mem-watchdog-status), you can leave a review or report issues there.

## Diagnostic Information

When reporting a problem, include:

1. **System**: `uname -a` output and `free -h` output
2. **VS Code version**: `code --version`
3. **Extension version**: visible in the Extensions panel → Mem Watchdog
4. **Daemon status**: `systemctl --user status mem-watchdog`
5. **Recent journal**: `journalctl --user -u mem-watchdog --since "1 hour ago" --no-pager | tail -50`

## Scope

This project targets **ChromeOS Crostini (Debian LXC containers)** specifically. While the daemon may work on other Linux systems, only Crostini is tested and supported.

## Response Time

This is a single-maintainer open-source project. Issues are triaged weekly. Critical stability bugs (OOM crashes, data loss) are prioritized.
