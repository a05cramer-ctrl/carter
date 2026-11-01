// Shared read helpers for CHARTER's public pages. No keys leave the server.
export const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const SEATS = 100;
export const isAddr = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ''));
export const rpcUrl = () => process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : (process.env.RPC_URL || 'https://api.mainnet-beta.solana.com');

const cache = new Map();
export async function cached(key, ms, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ms) return c.v;
  if (c?.p) return c.p;
  const p = fn().then(v => { cache.set(key, { t: Date.now(), v }); return v; }).catch(e => { cache.delete(key); throw e; });
  cache.set(key, { ...(c || {}), p });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return p;
}
export function send(res, code, body, maxAge = 10) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 4}`);
  res.status(code).json(body);
}
let id = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const limited = (r, j) => r.status === 429 || /rate limit/i.test(JSON.stringify(j?.error || (Array.isArray(j) ? j[0]?.error : '') || ''));
async function post(body, tries = 5) {
  for (let k = 0; ; k++) {
    const r = await fetch(rpcUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }).catch(() => ({ status: 429, json: async () => ({}) }));
    const j = await r.json().catch(() => ({}));
    if (limited(r, j) && k < tries) { await sleep(400 * 2 ** k); continue; }
    return { r, j };
  }
}
export async function rpc(method, params) {
  const { r, j } = await post({ jsonrpc: '2.0', id: ++id, method, params });
  if (j.error) throw new Error(j.error.message || 'rpc');
  if (!r.ok) throw new Error('rpc ' + r.status);
  return j.result;
}
// JSON-RPC batch (Helius allows it); falls back to sequential when the node refuses batches.
export async function rpcBatch(calls) {
  if (!calls.length) return [];
  try {
    const body = calls.map(([method, params], i) => ({ jsonrpc: '2.0', id: i, method, params }));
    const { j } = await post(body);
    if (!Array.isArray(j)) throw new Error('no batch');
    if (j.some(x => x.error && /rate/i.test(x.error.message || ''))) throw new Error('rate');
    const out = []; for (const x of j) out[x.id] = x.result ?? null; return out;
  } catch {
    const out = []; for (const [m, p] of calls) { try { out.push(await rpc(m, p)); } catch { out.push(null); } } return out;
  }
}
const dec = new TextDecoder();
export function memosOfParsed(tx) {
  const out = [];
  const ins = [...(tx?.transaction?.message?.instructions || []), ...((tx?.meta?.innerInstructions || []).flatMap(x => x.instructions))];
  for (const i of ins) if (i.programId === MEMO || i.program === 'spl-memo') { const s = typeof i.parsed === 'string' ? i.parsed : ''; if (s) out.push(s); }
  return out;
}

// First 100 distinct buyers of a mint, oldest first. Pages signatures back to the mint's first tx.
export async function firstBuyers(mint, { maxPages = 40, exclude = [] } = {}) {
  let before, sigs = [], pages = 0;
  while (pages < maxPages) {
    const page = await rpc('getSignaturesForAddress', [mint, { limit: 1000, ...(before ? { before } : {}) }]);
    pages++; if (!page?.length) break;
    sigs.push(...page); before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  const complete = pages < maxPages;
  sigs = sigs.filter(s => !s.err).reverse(); // oldest first
  const seats = []; const seen = new Set(exclude); let launcher = null;
  // Fast path on Helius: parsed transactions, 100 per request.
  if (process.env.HELIUS_API_KEY) {
    try {
      for (let i = 0; i < sigs.length && seats.length < SEATS; i += 100) {
        const chunk = sigs.slice(i, i + 100);
        const r = await fetch(`https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${process.env.HELIUS_API_KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactions: chunk.map(s => s.signature) }) });
        if (!r.ok) throw new Error('helius ' + r.status);
        const txs = await r.json();
        const order = new Map(chunk.map((s, k) => [s.signature, k]));
        txs.sort((a, b) => order.get(a.signature) - order.get(b.signature));
        for (const tx of txs) {
          if (tx.transactionError) continue;
          if (!launcher) { launcher = tx.feePayer; seen.add(launcher); continue; }
          const got = (tx.tokenTransfers || []).filter(t => t.mint === mint && t.toUserAccount === tx.feePayer).reduce((a, t) => a + (+t.tokenAmount || 0), 0);
          if (got > 0 && !seen.has(tx.feePayer) && seats.length < SEATS) { seen.add(tx.feePayer); seats.push({ wallet: tx.feePayer, sig: tx.signature, t: tx.timestamp, bought: String(got) }); }
        }
      }
      return { seats, launcher, txScanned: sigs.length, complete };
    } catch { seats.length = 0; seen.clear(); exclude.forEach(x => seen.add(x)); launcher = null; }
  }
  const step = +(process.env.RPC_BATCH || 40);
  for (let i = 0; i < sigs.length && seats.length < SEATS; i += step) {
    const chunk = sigs.slice(i, i + step);
    if (process.env.RPC_PAUSE) await sleep(+process.env.RPC_PAUSE);
    const txs = await rpcBatch(chunk.map(s => ['getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]]));
    txs.forEach((tx, k) => {
      if (!tx || tx.meta?.err) return;
      const keys = tx.transaction.message.accountKeys.map(a => (typeof a === 'string' ? { pubkey: a } : a));
      const signers = new Set(keys.filter(a => a.signer).map(a => a.pubkey));
      if (!launcher) { launcher = keys[0].pubkey; seen.add(launcher); return; }
      const pre = new Map(), post = new Map();
      for (const b of tx.meta.preTokenBalances || []) if (b.mint === mint) pre.set(b.owner, BigInt(b.uiTokenAmount.amount));
      for (const b of tx.meta.postTokenBalances || []) if (b.mint === mint) post.set(b.owner, BigInt(b.uiTokenAmount.amount));
      for (const [owner, amt] of post) {
        if (seats.length >= SEATS) break;
        if (!signers.has(owner) || seen.has(owner)) continue;
        if (amt > (pre.get(owner) || 0n)) { seen.add(owner); seats.push({ wallet: owner, sig: chunk[k].signature, t: tx.blockTime, bought: (amt - (pre.get(owner) || 0n)).toString() }); }
      }
    });
  }
  return { seats, launcher, txScanned: sigs.length, complete };
}

// Current balance of the mint for each wallet (any token account, both token programs).
export async function holdings(mint, wallets) {
  if (process.env.HELIUS_API_KEY) {
    try {
      const bal = new Map();
      for (let page = 1; page <= 20; page++) {
        const r = await rpc('getTokenAccounts', { mint, page, limit: 1000, options: { showZeroBalance: false } });
        for (const a of r?.token_accounts || []) bal.set(a.owner, (bal.get(a.owner) || 0n) + BigInt(a.amount));
        if ((r?.token_accounts || []).length < 1000) return wallets.map(w => (bal.get(w) || 0n).toString());
      }
    } catch {}
  }
  const res = await rpcBatch(wallets.map(w => ['getTokenAccountsByOwner', [w, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]]));
  return res.map(r => (r?.value || []).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n).toString());
}
