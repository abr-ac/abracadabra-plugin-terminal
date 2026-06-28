/**
 * Phase-1 de-risk: does a CRDT doc work as the transport for a live TTY?
 *
 * One process, two providers on ONE server doc (host + watcher, separate Y.Docs),
 * syncing through the real abracadabra-rs server. The host coalesces a byte
 * stream into a ring-trimmed Y.Array; the watcher measures what actually arrives.
 *
 * v2 fixes vs v1:
 *   - bounded op size per flush (MAXFLUSH) so a firehose can't push GB-sized ops
 *   - encodeStateAsUpdate only at start + end (the 1s sampler was starving timers)
 *   - feeder at 4ms for accurate synthetic rate; flush counter to prove cadence
 *
 * Usage:
 *   node bench.mjs [--mode=synthetic|pipe|pty] [--seconds=8] [--rate=50000]
 *                  [--cap=2000] [--frame=16] [--maxflush=131072]
 *                  [--url=http://127.0.0.1:3001] [--doc=<id>]
 */
import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { connectClient, openProvider, waitForSync } from "./connect.mjs";
import { SERVER_ROOT_ID } from "@abraca/dabra";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return [m[1], m[2] === "" ? true : m[2]];
  }),
);
const URL = args.url || "http://127.0.0.1:3001";
const MODE = args.mode || "synthetic";
const SECONDS = Number(args.seconds || 8);
const RATE = Number(args.rate || 50_000); // synthetic target bytes/sec
const CAP = Number(args.cap || 2000); // ring: max chunks kept materialized
const FRAME = Number(args.frame || 16); // coalesce flush interval (ms)
const MAXFLUSH = Number(args.maxflush || 128 * 1024); // max bytes per single op
const PENDING_CAP = 32 * 1024 * 1024;

const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmtKB = (n) => (n / 1024).toFixed(1) + "KB";

console.log(`[spike] mode=${MODE} seconds=${SECONDS} rate=${RATE}B/s cap=${CAP} frame=${FRAME}ms maxflush=${fmtKB(MAXFLUSH)}`);

// TWO independent peers: separate identities => separate WS connections =>
// no doc-name multiplexer collision (the v2 bug that stalled the watcher at ~94 ops).
const h = await connectClient(URL, "./.spike-host.key", "Spike Host");
const w = await connectClient(URL, "./.spike-watch.key", "Spike Watch");
let docId = args.doc;
if (!docId) {
  docId = randomUUID();
  let created = false, lastErr;
  for (const parent of [SERVER_ROOT_ID, "00000000-0000-0000-0000-000000000001"]) {
    try {
      await h.client.createChild(parent, { child_id: docId, label: "tty-spike", doc_type: "doc" });
      created = true;
      break;
    } catch (e) { lastErr = e; }
  }
  if (!created) throw new Error(`createChild failed: ${lastErr?.message ?? lastErr}`);
}

const host = openProvider(h.client, docId);
const watch = openProvider(w.client, docId);
await Promise.all([waitForSync(host.provider), waitForSync(watch.provider)]);
console.log(`[spike] synced on ${docId}\n`);

const hOut = host.doc.getArray("out");
const hIn = host.doc.getArray("in");
const wOut = watch.doc.getArray("out");
const wIn = watch.doc.getArray("in");

// ---- watcher measures arriving output ----
const lats = [], rtts = [];
let bytes = 0, count = 0, maxSeq = -1, firstAt = null, lastAt = null;
wOut.observe((event) => {
  for (const d of event.changes.delta) {
    if (!d.insert) continue;
    for (const c of d.insert) {
      if (c == null || c.t == null) continue;
      const now = performance.now();
      if (c.echo) rtts.push(now - c.t);
      else {
        lats.push(now - c.t);
        bytes += c.d?.length || 0;
        count++;
        maxSeq = Math.max(maxSeq, c.seq);
        firstAt ??= now;
        lastAt = now;
      }
    }
  }
});

// ---- host echoes inputs (proves keystroke direction) ----
hIn.observe((event) => {
  for (const d of event.changes.delta) {
    if (!d.insert) continue;
    for (const c of d.insert) {
      if (c?.t != null) hOut.push([{ seq: -1, t: c.t, d: new Uint8Array(0), echo: true }]);
    }
  }
});

// ---- coalesced + BOUNDED flush ----
let pending = [], pendingLen = 0, seq = 0, dropped = 0, flushes = 0;
const feed = (buf) => {
  if (pendingLen > PENDING_CAP) { dropped += buf.length; return; }
  pending.push(buf);
  pendingLen += buf.length;
};
const flush = () => {
  if (pendingLen === 0) return;
  let buf = Buffer.concat(pending, pendingLen);
  pending = []; pendingLen = 0;
  if (buf.length > MAXFLUSH) { dropped += buf.length - MAXFLUSH; buf = buf.subarray(buf.length - MAXFLUSH); }
  hOut.push([{ seq: seq++, t: performance.now(), d: new Uint8Array(buf) }]);
  flushes++;
  if (hOut.length > CAP) hOut.delete(0, hOut.length - CAP); // ring trim
};
const flushTimer = setInterval(flush, FRAME);

// ---- source ----
let feeder, child;
if (MODE === "synthetic") {
  const tick = 4;
  const perTick = Math.max(1, Math.round((RATE * tick) / 1000));
  feeder = setInterval(() => feed(Buffer.alloc(perTick, 0x78)), tick);
} else if (MODE === "pipe") {
  child = spawn("bash", ["-lc", "yes ABRACADABRA-TTY-SPIKE-LINE"], { stdio: ["pipe", "pipe", "ignore"] });
  child.stdout.on("data", (d) => feed(d));
} else if (MODE === "pty") {
  try {
    const pty = (await import("node-pty")).default ?? (await import("node-pty"));
    const term = pty.spawn(process.env.SHELL || "bash", [], { name: "xterm-color", cols: 120, rows: 40 });
    term.onData((s) => feed(Buffer.from(s, "utf8")));
    term.write("yes ABRACADABRA-TTY-SPIKE-LINE\r");
    child = { kill: () => term.kill() };
    console.log("[spike] node-pty live");
  } catch (e) {
    console.log(`[spike] node-pty unavailable (${e.message}); falling back to pipe`);
    child = spawn("bash", ["-lc", "yes ABRACADABRA-TTY-SPIKE-LINE"], { stdio: ["pipe", "pipe", "ignore"] });
    child.stdout.on("data", (d) => feed(d));
  }
}

// ---- watcher sends a keystroke every 1s ----
const inputTimer = setInterval(() => wIn.push([{ ks: "x", t: performance.now() }]), 1000);
// ---- cheap materialized sampler (no encode in the hot loop) ----
const matSamples = [];
const matTimer = setInterval(() => matSamples.push(hOut.length), 1000);

const startEncoded = Y.encodeStateAsUpdate(host.doc).length;
await new Promise((r) => setTimeout(r, SECONDS * 1000));

clearInterval(feeder); clearInterval(inputTimer); clearInterval(matTimer);
child?.kill?.();
await new Promise((r) => setTimeout(r, 500)); // drain tail
flush();
clearInterval(flushTimer);
// wait for CRDT convergence: does the watcher's doc catch up to the host's?
for (let i = 0; i < 24 && wOut.length < hOut.length; i++) {
  await new Promise((r) => setTimeout(r, 250));
}

const dur = firstAt && lastAt ? (lastAt - firstAt) / 1000 : SECONDS;
const finalEncoded = Y.encodeStateAsUpdate(host.doc).length;

console.log(`
──────── RESULTS (${MODE}, rate=${fmtKB(RATE)}/s) ────────
flushes (host ops)   ${flushes}   over ${SECONDS}s  (~${(flushes / SECONDS).toFixed(0)}/s, ideal ${(1000 / FRAME).toFixed(0)}/s)
output chunks recv   ${count}   (seq max ${maxSeq})
CONVERGENCE          watcher array ${wOut.length}  vs  host array ${hOut.length}  ${wOut.length === hOut.length ? "✓ converged" : "✗ DIVERGED (" + (hOut.length - wOut.length) + " missing)"}
bytes received       ${(bytes / 1024 / 1024).toFixed(2)} MB over ${dur.toFixed(2)}s
throughput           ${(bytes / 1024 / Math.max(0.001, dur)).toFixed(1)} KB/s
dropped (bounded)    ${(dropped / 1024 / 1024).toFixed(2)} MB
one-way latency      p50 ${pct(lats, 50)?.toFixed(1)}  p95 ${pct(lats, 95)?.toFixed(1)}  p99 ${pct(lats, 99)?.toFixed(1)}  max ${pct(lats, 100)?.toFixed(1)} ms
input round-trip     n=${rtts.length}  p50 ${pct(rtts, 50)?.toFixed(1)}  p95 ${pct(rtts, 95)?.toFixed(1)}  max ${pct(rtts, 100)?.toFixed(1)} ms
ring materialized    ${hOut.length} chunks (cap ${CAP})
encoded state        start ${fmtKB(startEncoded)}  end ${fmtKB(finalEncoded)}  (Δ ${fmtKB(finalEncoded - startEncoded)})
─────────────────────────────────
`);
process.exit(0);
