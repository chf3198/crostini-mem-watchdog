# Crostini Swap Reality — zram, zswap, and Container Isolation

**Environment:** Chromebook (i3-N305, 8 cores, 6.3 GB RAM) · ChromeOS Crostini (Debian 12 Bookworm) · Termina VM kernel 6.6.99-09070-g0245f6566c20  
**Last updated:** 2026-03-26  
**Related:** [`system-stability.md`](system-stability.md) §3–§4, issue #13

---

## 1. Executive Summary

The Crostini LXC container is a **true zero-swap environment** at every layer visible to the container kernel. Neither zram nor zswap exists in the Termina VM kernel — both are `not set` at compile time. The 16 GB zram configured via `crosh swap enable` lives entirely in the ChromeOS host hypervisor and provides zero relief for the container kernel's OOM killer. The watchdog's design — relying exclusively on `MemAvailable` and `MemTotal`, never reading swap metrics — is confirmed correct.

---

## 2. The Three-Layer Stack

```
ChromeOS Host (KVM hypervisor)
├── zram0 swap (16 GB compressed)         ← crosh swap enable 16384; lives HERE only
└── Termina VM (KVM guest, kernel 6.6.99)
    ├── CONFIG_ZRAM is not set            ← compiled out of VM kernel
    ├── CONFIG_ZSWAP is not set           ← compiled out of VM kernel
    └── LXC container "penguin" (Debian 12 — where VS Code runs)
        ├── SwapTotal: 0 kB               ← real value, not cosmetic
        ├── SwapFree: 0 kB                ← kernel no longer reports overflow sentinel
        └── No swap devices of any kind
```

The Termina VM kernel is a **separate build** from the ChromeOS host kernel. It is built by `cros-kernel@chromium.org` with Chromium OS clang 21.0 and explicitly disables both compression backends. The host-level zram addresses only OOM Pathway #2 (balloon driver pressure) — it cannot prevent OOM Pathway #1 (container kernel OOM) because the container kernel operates entirely on its own 6.3 GB RAM view.

---

## 3. Research Findings

All probes were run live on 2026-03-26 from inside the Crostini container.

### Q1: Is zram active on the Termina VM kernel?

**No. zram is not compiled into the Termina VM kernel.**

```
$ zcat /proc/config.gz | grep CONFIG_ZRAM
# CONFIG_ZRAM is not set
```

Confirmed by absence of:
- `/sys/module/zram` → `ENOENT`
- `/sys/class/zram-control` → `ENOENT`
- `/sys/block/zram*` → empty
- `lsblk | grep zram` → no matches

`modprobe zram` would fail — there is no kernel module to load.

### Q2: Does the Crostini container inherit a zram device?

**No. The container has zero swap devices of any kind.**

```
$ cat /proc/swaps
Filename    Type    Size    Used    Priority
(no entries)

$ grep -i swap /proc/meminfo
SwapCached:            0 kB
SwapTotal:             0 kB
SwapFree:              0 kB

$ free -h
Swap:    0B    0B    0B
```

The host-level zram is not exposed to the Termina VM via virtio-mem, shared namespace, or any other mechanism. The container inherits zero swap from the VM.

### Q3: Is `/sys/module/zswap` present inside the container?

**No. zswap is not compiled into the Termina VM kernel.**

```
$ zcat /proc/config.gz | grep CONFIG_ZSWAP
# CONFIG_ZSWAP is not set
```

Confirmed by absence of:
- `/sys/module/zswap` → `ENOENT`
- `/sys/module/zswap/parameters/` → `ENOENT`
- `/sys/kernel/debug/zswap/` → `ENOENT`

Both `CONFIG_ZRAM` and `CONFIG_ZSWAP` are compile-time decisions in the Termina VM kernel. They cannot be enabled without rebuilding the kernel, which is not user-accessible on ChromeOS.

### Q4: What do `/proc/meminfo` SwapTotal/SwapCached show?

**Inside the container — all zero:**

```
SwapCached:            0 kB
SwapTotal:             0 kB
SwapFree:              0 kB
```

The Termina VM shares the same kernel as the container (the container uses the VM's kernel via LXC). Therefore the Termina shell would report identical swap values.

**Historical note:** [`system-stability.md`](system-stability.md) §2 documents `SwapFree: 18446744073709551360 kB` (the uint64 overflow sentinel, 2^64 − 256) which caused earlyoom to crash. Current readings show `SwapFree: 0 kB`. This suggests a ChromeOS kernel update between the original observation and now may have fixed the sentinel behavior. **The watchdog's rule of never reading `SwapFree` remains correct** — the value has been unreliable across kernel versions and cannot be trusted regardless of what it shows today.

### Q5: Is `memory.zswap.writeback` a writable cgroup knob inside the container?

**No. The knob does not exist anywhere in the cgroup tree.**

```
$ find /sys/fs/cgroup/ -name 'memory.zswap.*' 2>&1
(zero results)
```

This is expected for two independent reasons:

1. **`CONFIG_ZSWAP is not set`** — the kernel has no zswap subsystem, so no zswap cgroup controller is registered.
2. **Cgroup v1 only** — the container runs cgroup v1 exclusively (11 separate controller mounts, zero cgroup2 mounts). The `memory.zswap.writeback` and `memory.zswap.max` knobs are **cgroup v2 features** (kernel 5.18+). Even if zswap were enabled, these knobs would not exist under cgroup v1.

```
$ findmnt -t cgroup,cgroup2
TARGET                          SOURCE FSTYPE OPTIONS
/sys/fs/cgroup/systemd          cgroup cgroup rw,...,name=systemd
/sys/fs/cgroup/memory           cgroup cgroup rw,...,memory
(+ 9 more v1 mounts; zero cgroup2)
```

The available cgroup v1 memory+swap knobs are present but irrelevant:
- `memory.memsw.usage_in_bytes` — tracks mem+swap, but swap is always 0
- `memory.memsw.limit_in_bytes` — unlimited sentinel
- `memory.swappiness` — value 60 (default), but no swap backend exists to use it

---

## 4. Implications for the Daemon

### What this confirms

1. **Never read `SwapFree` or `SwapTotal`** — both have been unreliable (historical overflow sentinel) and are always 0 when correct. There is no useful information in swap metrics on this system.
2. **`MemAvailable` and `MemTotal` are the only reliable memory metrics** from `/proc/meminfo`.
3. **The container kernel's OOM killer is the primary threat** (Pathway #1). It operates on the container's 6.3 GB RAM view with zero swap fallback. When `MemAvailable` approaches zero, SIGKILL is inevitable.
4. **Host-level zram (16 GB) mitigates only Pathway #2** (ChromeOS balloon driver shrinking the VM). It provides zero protection against Pathway #1.
5. **zswap cgroup knobs are permanently unavailable** — both due to `CONFIG_ZSWAP=not set` and cgroup v1 limitation.

### What cannot change

| Control | Status | Why |
|---|---|---|
| Enable zram inside container | ❌ Blocked | `CONFIG_ZRAM is not set` in VM kernel; no module to load |
| Enable zswap inside container | ❌ Blocked | `CONFIG_ZSWAP is not set` in VM kernel |
| Add swap file | ❌ Blocked | BTRFS nested subvolume; see `system-stability.md` §4 |
| Write `memory.zswap.writeback` | ❌ Blocked | Knob doesn't exist (cgroup v1 + no zswap) |
| Change `memory.swappiness` | ✅ Writable | But irrelevant — no swap backend to use it |

### Watchdog design validation

The daemon's approach is confirmed optimal for this environment:
- **Poll `MemAvailable`/`MemTotal`** — the only reliable memory metrics
- **Poll `/proc/pressure/memory`** — PSI provides early warning before `MemAvailable` crosses hard thresholds
- **Never read swap metrics** — unreliable and always zero
- **Kill Chrome/Playwright first** (`oom_score_adj=1000`) — only viable memory relief with no swap fallback
- **2s polling / 0.5s startup** — fast enough to intervene before the container kernel OOM fires

---

## 5. Kernel Version Record

```
$ cat /proc/version
Linux version 6.6.99-09070-g0245f6566c20
  (cros-kernel@chromium.org)
  (Chromium OS 21.0_pre574158 clang version 21.0.0git)
  #1 SMP PREEMPT_DYNAMIC Fri, 9 Jan 2026 02:13:23 -0800

$ zcat /proc/config.gz | grep -i 'CONFIG_ZRAM\|CONFIG_ZSWAP'
# CONFIG_ZSWAP is not set
# CONFIG_ZRAM is not set
```

If the Termina VM kernel is updated in a future ChromeOS release and these configs change, this document should be re-verified by re-running the probes in §3.
