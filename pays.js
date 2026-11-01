import { isAddr, cached, send, rpc, rpcBatch, memosOfParsed } from './_read.js';

// Payouts from a coin's vault: CHARTER|PAY|<mint>|<hour>|<lamportsEach>|<paidCount> memos.
export default async function handler(req, res) {
  const vault = req.query.vault;
  if (!isAddr(vault)) return send(res, 400, { error: 'vault' });
  try {
    const data = await cached('pays:' + vault, 30e3, async () => {
      const sigs = (await rpc('getSignaturesForAddress', [vault, { limit: 200 }])).filter(s => !s.err);
      const txs = await rpcBatch(sigs.slice(0, 100).map(s => ['getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]]));
      const pays = [];
      txs.forEach((tx, k) => { for (const m of memosOfParsed(tx)) { const f = m.split('|'); if (f[0] === 'CHARTER' && f[1] === 'PAY') pays.push({ mint: f[2], hour: f[3], each: +f[4] / 1e9, count: +f[5], sig: sigs[k].signature, t: tx.blockTime }); } });
      const bal = await rpc('getBalance', [vault]);
      return { pays, balance: (bal?.value || 0) / 1e9 };
    });
    send(res, 200, { ...data, at: Date.now() }, 20);
  } catch (e) { send(res, 502, { error: String(e.message || e) }, 5); }
}
