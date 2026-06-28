/**
 * Does AWARENESS (a different protocol path than doc-sync) escape the ~100-update
 * delivery ceiling that froze the doc-sync transport?
 *
 *   node awaretest.mjs --role=write --doc=ID --interval=33 --count=400
 *   node awaretest.mjs --role=read  --doc=ID --seconds=18
 */
import { connectClient, openProvider, waitForSync } from "./connect.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return [m[1], m[2] === "" ? true : m[2]];
}));
const URL = args.url || "http://127.0.0.1:3001";
const DOC = args.doc, ROLE = args.role;
if (!DOC || !ROLE) throw new Error("need --doc and --role");

if (ROLE === "write") {
  const INTERVAL = Number(args.interval || 33);
  const COUNT = Number(args.count || 400);
  const { client } = await connectClient(URL, "./.spike-host.key", "Spike Host");
  try { await client.createChild("00000000-0000-0000-0000-000000000000", { child_id: DOC, label: "awaretest", doc_type: "doc" }); } catch {}
  const { provider } = openProvider(client, DOC);
  await waitForSync(provider);
  const aw = provider.awareness;
  const payload = "x".repeat(256);
  console.log(`[write] awareness streaming seq 1..${COUNT} every ${INTERVAL}ms`);
  for (let i = 1; i <= COUNT; i++) {
    aw.setLocalStateField("tty", { seq: i, t: Date.now(), d: payload });
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
  console.log(`[write] done seq=${COUNT}; staying alive 3s`);
  await new Promise((r) => setTimeout(r, 3000));
  process.exit(0);
} else {
  const SECONDS = Number(args.seconds || 18);
  const { client } = await connectClient(URL, "./.spike-watch.key", "Spike Watch");
  const { provider } = openProvider(client, DOC);
  await waitForSync(provider);
  const aw = provider.awareness;
  let maxSeq = -1, recv = 0;
  const seqAt = [];
  aw.on("change", () => {
    for (const [cid, st] of aw.getStates()) {
      if (st?.tty?.seq != null && st.tty.seq > maxSeq) { maxSeq = st.tty.seq; recv++; }
    }
  });
  const seqTimer = setInterval(() => seqAt.push(maxSeq), 1000);
  console.log(`[read] watching awareness ${SECONDS}s`);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  clearInterval(seqTimer);
  console.log(`[read] maxSeq=${maxSeq} distinctRecv=${recv}\n[read] seqMax/s: ${seqAt.join(" → ")}  ${maxSeq > 150 ? "✓ awareness sustains" : "✗ also capped"}`);
  process.exit(0);
}
