// Shared server helpers for CHARTER site functions (files starting with _ are not routes on Vercel).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const LAUNCH_FEE_LAMPORTS = 10_000_000; // 0.01 SOL
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isBase58Key = (s) => typeof s === 'string' && B58.test(s);

export function rpcUrl() {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw httpError(500, 'HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export function fail(res, e) {
  const status = e.status || 500;
  if (status >= 500) console.error(e);
  send(res, status, { error: status >= 500 && !e.status ? 'server error' : e.message });
}

export async function readRaw(req, limit) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw httpError(413, 'body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** JSON body whether or not Vercel already parsed it. */
export async function readJson(req, limit = 64 * 1024) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = typeof req.body === 'string' ? Buffer.from(req.body) : Buffer.isBuffer(req.body) ? req.body : await readRaw(req, limit);
  if (raw.length > limit) throw httpError(413, 'body too large');
  try { return JSON.parse(raw.toString('utf8') || '{}'); } catch { throw httpError(400, 'invalid JSON'); }
}

let rpcId = 0;
export async function rpc(method, params) {
  const r = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!r.ok) throw httpError(502, `rpc http ${r.status}`);
  const j = await r.json();
  if (j.error) throw httpError(502, `rpc ${method}: ${j.error.message}`);
  return j.result;
}

let vaultsCache;
export function loadVaults() {
  if (vaultsCache) return vaultsCache;
  const p = join(dirname(fileURLToPath(import.meta.url)), 'vaults.json');
  const list = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(list) || !list.every(isBase58Key)) throw httpError(500, 'vaults.json invalid');
  vaultsCache = list;
  return list;
}

/** "[len] text; [len] text" -> ["text", ...] */
export function splitSigMemo(memo) {
  if (!memo || typeof memo !== 'string') return [];
  return memo.split(/;\s*(?=\[\d+\]\s)/).map((m) => m.replace(/^\[\d+\]\s?/, '').trim()).filter(Boolean);
}

export function parseLaunchMemo(text) {
  const p = String(text).split('|');
  if (p.length === 4 && p[0] === 'CHARTER' && p[1] === 'LAUNCH' && isBase58Key(p[2]) && isBase58Key(p[3])) return { mint: p[2], vault: p[3] };
  return null;
}

/**
 * Vaults already used: successful TREASURY txs carrying a LAUNCH memo.
 * Uses the memo field of getSignaturesForAddress; falls back to getTransaction(jsonParsed)
 * for signatures whose memo field is missing. Conservative: any successful LAUNCH memo marks the vault used.
 * Cached 30 s per warm instance.
 */
let usedCache = { at: 0, set: null, newest: null, all: new Set() };
export async function usedVaults(treasury) {
  if (usedCache.set && Date.now() - usedCache.at < 30_000) return usedCache.set;
  const found = new Set(usedCache.all);
  let before;
  let newest;
  for (let page = 0; page < 50; page++) {
    const opts = { limit: 1000, commitment: 'confirmed' };
    if (before) opts.before = before;
    if (usedCache.newest) opts.until = usedCache.newest;
    const sigs = await rpc('getSignaturesForAddress', [treasury, opts]);
    if (!newest && sigs[0]) newest = sigs[0].signature;
    const needTx = [];
    for (const s of sigs) {
      if (s.err) continue;
      if (s.memo) {
        for (const m of splitSigMemo(s.memo)) { const p = parseLaunchMemo(m); if (p) found.add(p.vault); }
      } else needTx.push(s.signature);
    }
    for (const sig of needTx.slice(0, 50)) {
      const tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
      for (const ix of tx?.transaction?.message?.instructions || []) {
        if ((ix.programId === MEMO_PROGRAM_ID || ix.program === 'spl-memo') && typeof ix.parsed === 'string') {
          const p = parseLaunchMemo(ix.parsed); if (p) found.add(p.vault);
        }
      }
    }
    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1].signature;
  }
  usedCache = { at: Date.now(), set: found, newest: newest || usedCache.newest, all: found };
  return found;
}
