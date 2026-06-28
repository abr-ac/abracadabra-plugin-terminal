/**
 * Split spike — HOST half (separate OS process from the watcher).
 * Creates the session doc, pumps a byte stream into a ring-trimmed Y.Array,
 * echoes inbound keystrokes. Run via run-split.sh.
 */
import * as Y from "yjs";
import { spawn } from "node:child_process";
import { connectClient, openProvider, waitForSync } from "./connect.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return [m[1], m[2] === "" ? true : m[2]];
}));
const URL = args.url || "http://127.0.0.1:3001";
const DOC = args.doc;
const MODE = args.mode || "synthetic";
const SECONDS = Number(args.seconds || 8);
const RATE = Number(args.rate || 50_000);
const FRAME = Number(args.frame || 16);
const MAXFLUSH = Number(args.maxflush || 128 * 1024);
const CAP = Number(args.cap || 2000);
if (!DOC) throw new Error("host: --doc required");

const { client } = await connectClient(URL, "./.spike-host.key", "Spike Host");
try { await client.createChild("00000000-0000-0000-0000-000000000000", { child_id: DOC, label: "tty-spike", doc_type: "doc" }); }
catch { /* may already exist */ }

const { doc, provider } = openProvider(client, DOC);
await waitForSync(provider);
const hOut = doc.getArray("out");
const hIn = doc.getArray("in");
console.log(`[host] synced ${DOC}`);

hIn.observe((event) => {
  for (const d of event.changes.delta) {
    if (!d.insert) continue;
    for (const c of d.insert) if (c?.t != null) hOut.push([{ seq: -1, t: c.t, d: new Uint8Array(0), echo: true }]);
  }
});

let pending = [], pendingLen = 0, seq = 0, dropped = 0, flushes = 0;
const PENDING_CAP = 32 * 1024 * 1024;
const feed = (buf) => { if (pendingLen > PENDING_CAP) { dropped += buf.length; return; } pending.push(buf); pendingLen += buf.length; };
const flush = () => {
  if (pendingLen === 0) return;
  let buf = Buffer.concat(pending, pendingLen); pending = []; pendingLen = 0;
  if (buf.length > MAXFLUSH) { dropped += buf.length - MAXFLUSH; buf = buf.subarray(buf.length - MAXFLUSH); }
  hOut.push([{ seq: seq++, t: performance.now(), d: new Uint8Array(buf) }]); flushes++;
  if (hOut.length > CAP) hOut.delete(0, hOut.length - CAP);
};
const flushTimer = setInterval(flush, FRAME);

let feeder, child;
if (MODE === "synthetic") {
  const tick = 4, perTick = Math.max(1, Math.round((RATE * tick) / 1000));
  feeder = setInterval(() => feed(Buffer.alloc(perTick, 0x78)), tick);
} else if (MODE === "pipe") {
  child = spawn("bash", ["-lc", "yes ABRACADABRA-TTY-SPIKE-LINE"], { stdio: ["pipe", "pipe", "ignore"] });
  child.stdout.on("data", (d) => feed(d));
}

await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(feeder); child?.kill?.();
await new Promise((r) => setTimeout(r, 300)); flush(); clearInterval(flushTimer);
const encoded = Y.encodeStateAsUpdate(doc).length;
console.log(`[host] DONE flushes=${flushes} seqMax=${seq - 1} array=${hOut.length} dropped=${(dropped / 1048576).toFixed(1)}MB encoded=${(encoded / 1024).toFixed(0)}KB`);
await new Promise((r) => setTimeout(r, 4000)); // stay alive so watcher can finish + converge
process.exit(0);
