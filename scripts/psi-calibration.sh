#!/usr/bin/env bash
# ── PSI Calibration for Crostini (Issue #14) ─────────────────────────────────
# Allocates memory in controlled steps and records PSI + MemAvailable at each.
# The watchdog daemon is running and will kill Chrome/helpers but NOT this
# script (it targets code/chrome/playwright processes only).
#
# SAFETY: Stops allocation when MemAvailable drops below FLOOR_MB.
# Use Ctrl+C or SIGTERM to abort. All stress processes are killed on exit.
#
# Output: scratch/psi-calibration-TIMESTAMP.csv
set -euo pipefail

STEP_MB=250               # allocate this much per step
HOLD_SEC=15               # hold each allocation for this many seconds (PSI avg10 needs ~10s)
SAMPLE_HZ=2               # samples per second during hold period
SAMPLE_SLEEP=0.5           # sleep between samples (1/SAMPLE_HZ) — bash integer only, no bc
FLOOR_MB=800              # stop allocating when MemAvailable drops below this
MAX_STEPS=12              # safety cap on number of allocation steps

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTFILE="scratch/psi-calibration-${TIMESTAMP}.csv"
mkdir -p scratch

# Cleanup: kill all stress child processes on exit
_pids=()
cleanup() {
  echo ""
  echo "Cleaning up stress processes..."
  for pid in "${_pids[@]}"; do
    kill -9 "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "Done. Results in: $OUTFILE"
}
trap cleanup EXIT INT TERM

echo "step,elapsed_s,mem_total_kb,mem_avail_kb,mem_avail_pct,psi_some_avg10,psi_full_avg10,psi_full_avg60,alloc_mb,vscode_rss_kb" > "$OUTFILE"

get_meminfo() {
  awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print t, a}' /proc/meminfo
}

get_psi() {
  awk '
    /^some/{for(i=1;i<=NF;i++) if($i~/^avg10=/) {sub("avg10=","",$i); some=$i}}
    /^full/{
      for(i=1;i<=NF;i++) {
        if($i~/^avg10=/) {sub("avg10=","",$i); full10=$i}
        if($i~/^avg60=/) {sub("avg60=","",$i); full60=$i}
      }
    }
    END{print some, full10, full60}
  ' /proc/pressure/memory
}

get_vscode_rss() {
  ps -C code -o rss= 2>/dev/null | awk '{s+=$1} END{print s+0}'
}

start_epoch=$(date +%s)
total_alloc=0

echo "=== PSI Calibration Start ==="
echo "Step size: ${STEP_MB} MB | Hold: ${HOLD_SEC}s | Floor: ${FLOOR_MB} MB | Max steps: ${MAX_STEPS}"
echo "Output: $OUTFILE"
echo ""

# Sample baseline for 10s first
echo "── Baseline (10s) ──"
for i in $(seq 1 $((10 * SAMPLE_HZ))); do
  now_epoch=$(date +%s)
  elapsed=$(( now_epoch - start_epoch ))
  read -r mtotal mavail <<< "$(get_meminfo)"
  read -r psi_some psi_full10 psi_full60 <<< "$(get_psi)"
  mavail_pct=$(( mavail * 100 / mtotal ))
  vrss=$(get_vscode_rss)
  echo "0,$elapsed,$mtotal,$mavail,$mavail_pct,$psi_some,$psi_full10,$psi_full60,0,$vrss" >> "$OUTFILE"
  sleep "$SAMPLE_SLEEP"
done
echo "  Baseline complete. MemAvailable=$(awk '/^MemAvailable:/{printf "%.0f MB", $2/1024}' /proc/meminfo)"

# Allocate in steps
for step in $(seq 1 "$MAX_STEPS"); do
  # Check floor before allocating
  mavail_kb=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  mavail_mb=$(( mavail_kb / 1024 ))
  if (( mavail_mb < FLOOR_MB + STEP_MB )); then
    echo "  ⚠ Approaching floor (${mavail_mb} MB available, floor=${FLOOR_MB} MB) — stopping"
    break
  fi

  total_alloc=$(( total_alloc + STEP_MB ))
  echo "── Step ${step}: allocating ${STEP_MB} MB (total: ${total_alloc} MB) ──"

  # Allocate memory using python3 (holds bytes in a list to prevent GC)
  python3 -c "
import time, sys
# Allocate ${STEP_MB} MB as a bytearray (resident immediately)
data = bytearray(${STEP_MB} * 1024 * 1024)
# Touch every page to ensure residency
for i in range(0, len(data), 4096):
    data[i] = 1
sys.stdout.write('allocated\n')
sys.stdout.flush()
# Hold until killed
while True:
    time.sleep(60)
" &
  _pids+=($!)

  # Wait a moment for allocation to register
  sleep 1

  # Sample during hold period
  for i in $(seq 1 $((HOLD_SEC * SAMPLE_HZ))); do
    now_epoch=$(date +%s)
    elapsed=$(( now_epoch - start_epoch ))
    read -r mtotal mavail <<< "$(get_meminfo)"
    read -r psi_some psi_full10 psi_full60 <<< "$(get_psi)"
    mavail_pct=$(( mavail * 100 / mtotal ))
    vrss=$(get_vscode_rss)
    echo "${step},$elapsed,$mtotal,$mavail,$mavail_pct,$psi_some,$psi_full10,$psi_full60,$total_alloc,$vrss" >> "$OUTFILE"

    # Emergency check
    if (( mavail < FLOOR_MB * 1024 )); then
      echo "  🚨 Below floor! MemAvailable=$(( mavail / 1024 )) MB — aborting"
      break 2
    fi
    sleep "$SAMPLE_SLEEP"
  done

  mavail_kb=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  read -r psi_some psi_full10 psi_full60 <<< "$(get_psi)"
  echo "  Step ${step} complete: avail=$(( mavail_kb / 1024 )) MB, PSI some=${psi_some}, full10=${psi_full10}, full60=${psi_full60}"
done

echo ""
echo "=== Calibration Complete ==="
echo "Total allocated: ${total_alloc} MB across ${#_pids[@]} processes"
echo "Results: $OUTFILE"
echo "Lines: $(wc -l < "$OUTFILE")"
