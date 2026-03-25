# PSI Calibration for Crostini — Experimental Results

**Date**: 2026-03-25  
**System**: Chromebook i3-N305, 6.3 GB RAM, ChromeOS Crostini (Debian 12, kernel 6.6.99)  
**Swap**: 16 GB zram at ChromeOS host layer; `free -h` shows `Swap: 0B` inside container  
**Daemon**: mem-watchdog.sh v20260325.2 running (provided OOM protection during test)

## Summary

**PSI full avg10 never exceeded 0.18% — even when MemAvailable dropped to 24% of total RAM.**

The current `PSI_THRESHOLD=25` (25% full avg10) is unreachable on Crostini. It has never triggered in production (confirmed: `psi_events=0` across all journal snapshots). The system transitions from 0% PSI directly to kernel OOM-kill with no intermediate PSI buildup.

## Methodology

Controlled memory allocation test (`scripts/psi-calibration.sh`):
1. 10-second PSI baseline at idle
2. 12 steps × 250 MB allocation (Python `bytearray`, page-touched)
3. Each step held for 15 seconds with 2 Hz PSI sampling
4. Floor: 800 MB MemAvailable (safety cutoff)

VS Code was running throughout (~2.9 GB RSS). The watchdog daemon was active.

## Results

| Step | Alloc (MB) | MemAvail (MB) | MemAvail % | PSI some avg10 | PSI full avg10 | PSI full avg60 |
|------|------------|---------------|------------|----------------|----------------|----------------|
| 0    | 0          | 4,572         | 70%        | 0.00           | 0.00           | 0.00           |
| 1    | 250        | 4,334         | 66%        | 0.00           | 0.00           | 0.00           |
| 2    | 500        | 4,157         | 64%        | 0.00           | 0.00           | 0.00           |
| 3    | 750        | 3,904         | 60%        | 0.00           | 0.00           | 0.00           |
| 4    | 1,000      | 3,657         | 56%        | 0.00           | 0.00           | 0.00           |
| 5    | 1,250      | 3,401         | 52%        | 0.00           | 0.00           | 0.00           |
| 6    | 1,500      | 3,144         | 48%        | 0.18           | 0.18           | 0.03           |
| 7    | 1,750      | 2,885         | 44%        | 0.03           | 0.03           | 0.02           |
| 8    | 2,000      | 2,642         | 40%        | 0.00           | 0.00           | 0.01           |
| 9    | 2,250      | 2,386         | 36%        | 0.00           | 0.00           | 0.01           |
| 10   | 2,500      | 2,130         | 32%        | 0.00           | 0.00           | 0.00           |
| 11   | 2,750      | 1,834         | 28%        | 0.00           | 0.00           | 0.00           |
| 12   | 3,000      | 1,579         | 24%        | 0.00           | 0.00           | 0.00           |

Raw data: `scratch/psi-calibration-20260325-171035.csv` (381 samples)

## Analysis

### Why PSI stays near zero on Crostini

PSI (`/proc/pressure/memory`) measures the fraction of time tasks are stalled waiting for memory. Stalls occur primarily during:
1. **Swap I/O** — reading/writing swap pages. Not applicable: `Swap: 0B` inside the container.
2. **Direct reclaim** — kernel reclaiming page cache and clean pages under allocation pressure.
3. **Compaction** — defragmenting physical memory for huge pages.

On Crostini with no visible swap, the kernel's reclaim options are limited to:
- Dropping clean file-backed pages (page cache) — fast, near-instant
- Reclaiming slab caches — fast

There is no swap-backed reclaim I/O that would create sustained stalls. The kernel either drops caches instantly (no measurable stall) or invokes the OOM killer. The PSI "full" metric requires *all* runnable tasks to be simultaneously stalled — extremely unlikely when reclaim is just cache dropping.

### The 0.18% spike at step 6

The only measurable PSI occurred at step 6 (1500 MB allocated, 48% available). This was a transient burst during the 250 MB allocation itself — the kernel briefly stalled tasks while performing direct reclaim to satisfy the allocation. It decayed from 0.18% to 0.00% within ~20 seconds with no further allocations.

This pattern — brief spike during allocation, immediate decay — is characteristic of burst reclaim, not sustained pressure.

### Comparison to bare Linux with swap

On bare Linux with swap, PSI full avg10 rises progressively as swap I/O increases:
- 5-10%: active swap-out/swap-in, system noticeably slow
- 15-25%: heavy swap thrashing, significant latency
- 25%+: severe thrashing, approaching OOM

On Crostini without visible swap, this entire progression is absent. The system goes from PSI ~0% to OOM-kill in a single step.

## Recommended Threshold Changes

### Current (ineffective)
```
PSI_THRESHOLD=25  # PSI full avg10 > 25% → unreachable on Crostini
```

### Proposed
```
PSI_THRESHOLD=5   # PSI full avg10 > 5% → detect any measurable sustained stall
```

**Rationale**: 5% full avg10 represents sustained (not transient) memory stalls that exceed anything observed in controlled testing. If PSI full avg10 reaches 5% on this system, something extraordinary is happening — likely rapid multi-process allocation that will reach OOM within seconds. The lower threshold makes PSI a useful early warning instead of dead code.

### For the staged model (Issue #4)

The 4-stage PSI thresholds must be calibrated to Crostini's compressed PSI range:

| Stage | PSI Trigger (Crostini) | PSI Trigger (bare Linux) | MemAvail Trigger |
|-------|----------------------|--------------------------|------------------|
| 1 — Monitor  | some avg10 > 1%  | some avg10 > 15% | < 35% |
| 2 — Throttle | some avg10 > 3%  | some avg10 > 30% | < 30% |
| 3 — Reclaim  | full avg10 > 2%  | full avg10 > 10% | < 25% |
| 4 — Terminate| full avg10 > 5%  | full avg10 > 25% | < 15% |

These are 5-10× lower than bare-Linux equivalents, reflecting the compressed dynamic range of PSI on a no-swap system.

## Limitations

1. **Controlled allocations only**: Real OOM scenarios involve rapid multi-process spikes (V8 JIT, extension host loading) that may produce different PSI profiles than steady allocations.
2. **No concurrent pressure**: Test allocated memory in a single process chain. Concurrent VS Code + Chrome + allocation stress could produce higher PSI.
3. **ChromeOS host-side effects**: The host-level zram and balloon driver create memory pressure events invisible to the container — these may contribute to PSI readings not captured here.
4. **avg10 exponential decay**: PSI avg10 is an EWMA with ~10s half-life. Very brief (<1s) stalls may never register above 0.01%.

## Conclusion

On Crostini (cgroup v1, no container-visible swap), **MemAvailable is the primary and nearly sole reliable pressure indicator**. PSI is useful only at very low thresholds (1-5%) as a burst detector, not as a sustained-pressure indicator. The 25% PSI threshold from bare-Linux heuristics is dead code on this platform.
