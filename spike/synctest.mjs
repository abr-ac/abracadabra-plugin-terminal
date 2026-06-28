/**
 * Minimal two-process live-sync isolation test.
 * writer: bumps a counter on a slow cadence. reader: logs every value it sees.
 * If the reader sees the counter climb 1..N, basic live sync works and the
 * terminal stall is purely an op-FREQUENCY / broadcast-capacity problem.
 *
 *   node synctest.mjs --role=write --doc=ID --interval=500 --count=20
 *   node synctest.mjs --role=read  --doc=ID --seconds=14
 */
import { connectClient, openProvider, waitForSync } from "./connect.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return [m[1], m[2] === "" ? true : m[2]];
}));
const URL = args.url || "http://127.0.0.1:3001";
const DOC = args.doc;
const ROLE = args.role;
if (!DOC || !ROLE) throw new Error("need --doc and --role");

if (ROLE === "write") {
  const INTERVAL = Number(args.interval || 500);
  const COUNT = Number(args.count || 20);
  const { client } = await connectClient(URL, "./.spike-host.key", "Spike Host");
  try { await client.createChild("00000000-0000-0000-0000-000000000000", { child_id: DOC, label: "synctest", doc_type: "doc" }); } catch {}
  const { doc, provider } = openProvider(client, DOC);
  await waitForSync(provider);
  const m = doc.getMap("m");
  console.log(`[write] synced; bumping n 1..${COUNT} every ${INTERVAL}ms`);
  for (let i = 1; i <= COUNT; i++) {
    m.set("n", i);
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
  console.log(`[write] done, final n=${COUNT}; staying alive 4s`);
  await new Promise((r) => setTimeout(r, 4000));
  process.exit(0);
} else {
  const SECONDS = Number(args.seconds || 14);
  const { client } = await connectClient(URL, "./.spike-watch.key", "Spike Watch");
  const { doc, provider } = openProvider(client, DOC);
  await waitForSync(provider);
  const m = doc.getMap("m");
  const seen = [];
  m.observe(() => { seen.push(m.get("n")); console.log(`[read] n=${m.get("n")}  (t=${Date.now() % 100000})`); });
  console.log(`[read] synced; initial n=${m.get("n")}; watching ${SECONDS}s`);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  console.log(`[read] SAW ${seen.length} updates: [${seen.join(",")}]  ${seen.length >= 15 ? "✓ live sync OK" : "✗ live sync BROKEN"}`);
  process.exit(0);
}
