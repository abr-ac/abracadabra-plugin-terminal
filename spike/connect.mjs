/**
 * Connection helper for the Terminal transport spike.
 * Ed25519 keypair + challenge-response login/register + provider open,
 * vendored from @abraca/resend's crypto/server so the spike has no workspace dep.
 */
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AbracadabraClient, AbracadabraProvider } from "@abraca/dabra";
import * as Y from "yjs";

ed.hashes.sha512 = sha512;
ed.hashes.sha512Async = (m) => Promise.resolve(sha512(m));

const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));

export function loadOrCreateKey(path) {
  if (existsSync(path)) {
    const seed = readFileSync(path);
    if (seed.length !== 32) throw new Error(`bad key length ${seed.length} at ${path}`);
    const priv = new Uint8Array(seed);
    return { priv, pub: b64u(ed.getPublicKey(priv)) };
  }
  const priv = ed.utils.randomSecretKey();
  writeFileSync(path, Buffer.from(priv), { mode: 0o600 });
  return { priv, pub: b64u(ed.getPublicKey(priv)) };
}

const sign = (challengeB64, priv) => b64u(ed.sign(unb64u(challengeB64), priv));

export async function connectClient(url, keyPath, name) {
  const { priv, pub } = loadOrCreateKey(keyPath);
  const signFn = (c) => Promise.resolve(sign(c, priv));
  const client = new AbracadabraClient({ url, persistAuth: false });
  try {
    await client.loginWithKey(pub, signFn);
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    const msg = String(err?.message ?? "").toLowerCase();
    const notRegistered =
      status === 404 || status === 422 ||
      (status === 401 && /not registered|user not found|no such user/.test(msg));
    if (!notRegistered) throw err;
    console.error(`[spike] key not registered, registering ${name}...`);
    await client.registerWithKey({
      publicKey: pub,
      username: name.replace(/\s+/g, "-").toLowerCase(),
      displayName: name,
      deviceName: name,
    });
    await client.loginWithKey(pub, signFn);
  }
  return { client, pub, signFn };
}

export function openProvider(client, docId) {
  const doc = new Y.Doc({ guid: docId });
  const provider = new AbracadabraProvider({
    name: docId,
    document: doc,
    client,
    disableOfflineStore: true,
  });
  return { doc, provider };
}

export function waitForSync(provider, timeoutMs = 15000) {
  if (provider.isSynced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.off("synced", handler);
      reject(new Error(`sync timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    function handler() {
      clearTimeout(timer);
      provider.off("synced", handler);
      resolve();
    }
    provider.on("synced", handler);
  });
}
