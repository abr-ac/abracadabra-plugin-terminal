# Phase-1 spike — CRDT-as-TTY transport — findings & verdict

**Date:** 2026-06-13 · **Server:** local `target/debug/abracadabra` @ `127.0.0.1:3001`
(registration open, `authenticated=editor`) · dabra `2.27.0`, yjs `13.6.30`, Node 23.

Throwaway spike. Goal: before building anything, decide whether a Yjs document can
carry a **live, bidirectional terminal** to all peers with access. Two providers
(host + watcher) sync through the real server; the host pumps a byte stream into a
ring-trimmed `Y.Array`, the watcher measures what arrives.

## Verdict: **GO**, via a hybrid transport (not pure doc-sync)

Doc-sync alone is **not** usable for the live byte stream (hard delivery ceiling, below).
Awareness **is**. So:

| Plane | Transport | Why |
|---|---|---|
| **Live TTY bytes** (output + resize) | **awareness** | ephemeral, high-rate, no ceiling (proven 30Hz × 400) |
| **Scrollback snapshot + late-joiner state** | **doc** (subdoc/session) | persisted, low op-rate |
| **Input (keystrokes)** | **doc** (`in` array) | low-rate; round-trip 2–5ms |
| **Session metadata / control** | **doc** + awareness host announce | start/stop/host/dims |

This is the hybrid the design brainstorm anticipated, now measured.

## What works (great)

- End-to-end: Ed25519 register → login → `createChild` → two-peer sync → bidirectional. ✅
- **Latency superb** (loopback): one-way output **p50 1.4ms / p95 ~2–3ms** at 50KB/s;
  **2.8ms** even at a 2MB/s burst. Input round-trip **2–5ms**.
- **Basic live sync is solid**: slow counter (2/s, 10/s) propagated 1:1, zero loss.
- **Awareness sustains a real stream**: 30Hz × 400 updates tracked 58→400 unbroken
  (372/400 distinct — awareness coalesces, last-write-wins, fine for a live screen).

## ⮕ ROOT-CAUSED (update): the ceiling is `update_limit = 100`, not a bug

The "doc-sync ceiling" below was traced to **`config.toml [extensions.rate_limit]
update_limit = 100`** (Yjs updates / user / doc / 60s). Past 100/60s the server drops
updates (no nack → silent divergence). Proof: env override `ABRA_EXT_RATE_LIMIT_UPDATE_LIMIT=1000000`
→ 60Hz stream climbed 151→706 unbroken, converged, 0 warnings. `awareness_limit = 30000`
(500/s, 300×) is why awareness sustained — the limiter intentionally steers high-freq
traffic to awareness = our hybrid. **No server fix needed.** (A separate latent
broadcast-teardown bug was found & reverted — see the board card.) The section below is
the original, pre-root-cause write-up.

## The blocker we found (doc-sync delivery ceiling)

A subscribed consumer **stops receiving incremental doc updates after ~90–100 total**,
permanently, with **no auto-resync** — independent of cadence:

| cadence (small ops) | result |
|---|---|
| 2/s, 10/s (≤~90 total) | ✅ full, no loss |
| 25/s, 50/s | ✗ froze at value ~98 |
| terminal bench 10Hz, 60Hz | ✗ froze at seq ~90–98 (host kept climbing to 159/544) |

Likely the server broadcast path lagging + dropping the consumer (`broadcast_capacity` /
`update_batch_limit=100` neighborhood) with no recovery. Production collab doesn't hit
this (slower edit rates / client behaviors), so **root-cause is a separate
abracadabra-rs/provider investigation** — but any high-write-rate doc is exposed.

## Other findings (design inputs)

- **Naive unbounded output self-destructs**: `yes` firehose pushed 8MB Yjs ops →
  doc ballooned to **800MB**, synced nothing. Output MUST be bounded per flush +
  flow-controlled. (Fixed in bench with `MAXFLUSH`.)
- **Persisted bytes are expensive**: storing raw output in a `Y.Array` cost ~11MB
  encoded for ~3MB of transient output (Uint8Array + trim tombstones don't reclaim).
  → another reason the live stream rides awareness; the doc keeps only a trimmed
  snapshot. Sessions should be **subdocs** so they can be discarded wholesale.
- **node-pty** not needed for the spike; real PTY deferred to Phase 3 (helper binary).
- **Single-process tests lie**: host+watcher in one Node process starve each other;
  always test peers as separate OS processes (`host.mjs`/`watch.mjs`).

## Open items feeding the plan

1. **Awareness stream needs lossless gap-recovery**: it's last-write-wins (coalesces).
   Carry a `seq` per delta; on a detected gap, reconcile from the periodic doc
   snapshot (or request a catch-up). Output bytes can't be silently dropped.
2. **File the doc-sync ceiling** as an abracadabra-rs robustness bug (heal lagged
   consumers via resync instead of silent permanent drop).
3. Phase 2 contract decision (host-agnostic `requires:['process']` runner) is unblocked
   — transport question answered.

## Files
`connect.mjs` (auth/provider helper) · `bench.mjs` (single-process, instrumented) ·
`host.mjs`/`watch.mjs` (faithful two-process) · `synctest.mjs` (doc-sync cadence) ·
`awaretest.mjs` (awareness stream). Run e.g.:
`DOC=$(uuidgen); node host.mjs --doc=$DOC --rate=500000 --seconds=16 --frame=100 & sleep 1.5; node watch.mjs --doc=$DOC --seconds=15`
