/**
 * Split spike — WATCHER half (separate OS process from the host).
 * Measures one-way latency, throughput, input round-trip, and whether the
 * doc keeps climbing (no ~1.5s cutoff) and converges. Run via run-split.sh.
 */
import { connectClient, openProvider, waitForSync } from "./connect.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return [m[1], m[2] === "" ? true : m[2]];
}));
const URL = args.url || "http://127.0.0.1:3001";
const DOC = args.doc;
const SECONDS = Number(args.seconds || 6);
if (!DOC) throw new Error("watch: --doc required");

const pct = (arr, p) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

const { client } = await connectClient(URL, "./.spike-watch.key", "Spike Watch");
const { doc, provider } = openProvider(client, DOC);
await waitForSync(provider);
const wOut = doc.getArray("out");
const wIn = doc.getArray("in");
console.log(`[watch] synced ${DOC}`);

const lats = [], rtts = [];
let bytes = 0, count = 0, maxSeq = -1, firstAt = null, lastAt = null;
const seqAt = []; // (t, maxSeq) samples to detect a cutoff
wOut.observe((event) => {
  for (const d of event.changes.delta) {
    if (!d.insert) continue;
    for (const c of d.insert) {
      if (c == null || c.t == null) continue;
      const now = performance.now();
      if (c.echo) rtts.push(now - c.t);
      else { lats.push(now - c.t); bytes += c.d?.length || 0; count++; maxSeq = Math.max(maxSeq, c.seq); firstAt ??= now; lastAt = now; }
    }
  }
});
const inputTimer = setInterval(() => wIn.push([{ ks: "x", t: performance.now() }]), 1000);
const seqTimer = setInterval(() => seqAt.push(maxSeq), 1000);

await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(inputTimer); clearInterval(seqTimer);
await new Promise((r) => setTimeout(r, 2000)); // converge window

const dur = firstAt && lastAt ? (lastAt - firstAt) / 1000 : SECONDS;
console.log(`
──────── WATCH RESULTS ────────
recv chunks          ${count}   (seqMax ${maxSeq})  array=${wOut.length}
seqMax per second    ${seqAt.join(" → ")}   ${maxSeq > 150 ? "✓ keeps climbing" : "✗ stalled"}
bytes                ${(bytes / 1048576).toFixed(2)} MB over ${dur.toFixed(2)}s  =>  ${(bytes / 1024 / Math.max(0.001, dur)).toFixed(0)} KB/s
one-way latency      p50 ${pct(lats, 50)?.toFixed(1)}  p95 ${pct(lats, 95)?.toFixed(1)}  p99 ${pct(lats, 99)?.toFixed(1)}  max ${pct(lats, 100)?.toFixed(1)} ms
input round-trip     n=${rtts.length}  p50 ${pct(rtts, 50)?.toFixed(1)}  p95 ${pct(rtts, 95)?.toFixed(1)} ms
─────────────────────────────────`);
process.exit(0);
