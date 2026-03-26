# ChromeOS resourced D-Bus — Accessibility from Crostini

**Status:** ❌ Blocked — `org.chromium.ResourceManager` is not reachable from inside the Crostini container.  
**Investigated:** 2026-03-26  
**Environment:** ChromeOS Crostini (Debian 12, kernel 6.6.99), i3-N305, 6.3 GB RAM

---

## Goal

Query the ChromeOS `resourced` daemon's `GetAvailableMemoryKB` and `GetMemoryMarginsKB` methods to get host-accurate memory thresholds, replacing hard-coded percentage thresholds in the watchdog.

## D-Bus Interface (Host-Side)

```
Service:  org.chromium.ResourceManager
Object:   /org/chromium/ResourceManager
Methods:
  GetAvailableMemoryKB    → uint64  (host-visible available memory)
  GetMemoryMarginsKB      → (uint64 critical, uint64 moderate)
```

## Investigation Results

### 1. Direct D-Bus query — ServiceUnknown

```bash
$ dbus-send --system --dest=org.chromium.ResourceManager \
    --type=method_call --print-reply \
    /org/chromium/ResourceManager \
    org.chromium.ResourceManager.GetAvailableMemoryKB

Error org.freedesktop.DBus.Error.ServiceUnknown:
  The name org.chromium.ResourceManager was not provided by any .service files
```

`resourced` runs on the ChromeOS host, outside the Termina VM. Its D-Bus registration exists on the host's system bus, which is not forwarded into the VM or LXC container.

### 2. Available D-Bus services inside the container

**System bus:** `org.freedesktop.DBus`, `org.freedesktop.login1`, `org.freedesktop.systemd1`, `org.freedesktop.PolicyKit1`, `org.freedesktop.RealtimeKit1`

**Session bus:** `org.freedesktop.Notifications`, `org.freedesktop.ScreenSaver`, `org.freedesktop.impl.portal.desktop.cros`, `org.a11y.Bus`, `org.pulseaudio.Server`, `ca.desrt.dconf`

No ChromeOS-specific services (`org.chromium.*`) are present on either bus.

### 3. Termina VM namespace — same bus

```bash
$ sudo -n nsenter -t 1 --mount --pid -- dbus-send --system \
    --dest=org.freedesktop.DBus --type=method_call --print-reply \
    /org/freedesktop/DBus org.freedesktop.DBus.ListNames
```

Identical service list. The container and Termina VM share the same D-Bus daemon — there is no second bus with host services.

### 4. Garcon — no memory proxy

Garcon (`/opt/google/cros-containers/bin/garcon.elf`) runs inside the container and communicates with the host's `cicerone` daemon via gRPC over VSOCK. However:

- Garcon's gRPC interface handles file opening, URL launching, package installation, and icon registration — **not memory queries**.
- No local socket or D-Bus service is exposed by garcon.
- The garcon binary (Go, statically linked) contains no `memory`, `resource`, `margin`, or `balloon` string references.

### 5. vmmms_client — broken pipe

```bash
$ /opt/google/cros-containers/bin/vmmms_client
Error: Failed to write the packet
Caused by: Broken pipe (os error 32)
```

`vmmms_client` (VM Memory Management Service client) exists but its VSOCK connection to the host is not established. This binary likely communicates with `concierge` on the host for balloon control, but the channel is not available from inside the LXC container.

### 6. /proc/meminfo — VM and container are identical

```bash
# nsenter into Termina (PID 1 namespace):
MemTotal:     6626084 kB
MemAvailable: 5041520 kB

# Container view:
MemTotal:     6626084 kB
MemAvailable: 5042584 kB
```

The container and Termina VM share the same kernel — `/proc/meminfo` is the same source. There is no hidden memory layer between the VM and the container.

### 7. No balloon driver exposed

- `/sys/devices/pci*/*/balloon/` does not exist inside the container
- `/proc/net/vsock` does not exist
- `dmesg` shows no balloon or virtio-mem references

## Architecture Summary

```
ChromeOS Host
├── resourced (D-Bus: org.chromium.ResourceManager) ← HERE, unreachable
├── concierge (manages VMs)
│   └── Termina VM (crosvm/KVM)
│       ├── maitred (PID 1, VM init)
│       ├── cicerone (container orchestration)
│       ├── garcon ←→ cicerone (gRPC over VSOCK, no memory API)
│       └── LXC container "penguin"
│           ├── D-Bus: standard Debian services only
│           ├── /proc/meminfo = VM's /proc/meminfo (shared kernel)
│           └── mem-watchdog.sh reads /proc/meminfo ← best available
```

## Conclusion

**`/proc/meminfo` MemAvailable is the best available memory signal.** It reflects the Termina VM's actual available memory, which is the same view the container kernel uses for OOM decisions. There is no path to query the ChromeOS host's `resourced` for host-accurate margins from inside the container.

### Potential future paths (not currently viable)

1. **ChromeOS feature request**: Ask for a `memory.pressure` or similar file to be exposed into Termina via virtio-fs or a garcon gRPC extension.
2. **Custom VSOCK listener**: Write a host-side ChromeOS extension or crouton-style script that bridges resourced data into the VM. Requires developer mode and is fragile across ChromeOS updates.
3. **cros_healthd telemetry**: ChromeOS's `cros_healthd` has a `TelemetryService` that can report memory info, but it runs on the host's D-Bus and is equally unreachable.

None of these are actionable without ChromeOS-level changes or developer mode modifications.
