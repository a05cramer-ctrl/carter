import { isAddr, cached, send, rpc, rpcBatch, memosOfParsed } from './_read.js';

// Every coin launched through Charter: read from the treasury's LAUNCH memos, plus live market data.
export default async function handler(req, res) {
  const treasury = req.query.t || process.env.TREASURY;
  if (!isAddr(treasury)) return send(res, 200, { coins: [], live: false });
  try {
    const coins = await cached('coins:' + treasury, 20e3, async () => {
      const sigs = (await rpc('getSignaturesForAddress', [treasury, { limit: 500 }])).filter(s => !s.err);
      const out = [];
      for (let i = 0; i < sigs.length; i += 50) {
        const txs = await rpcBatch(sigs.slice(i, i + 50).map(s => ['getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]]));
        txs.forEach((tx, k) => { for (const m of memosOfParsed(tx)) { const f = m.split('|'); if (f[0] === 'CHARTER' && f[1] === 'LAUNCH' && isAddr(f[2])) out.push({ mint: f[2], vault: f[3], sig: sigs[i + k].signature, t: tx.blockTime, launcher: tx.transaction.message.accountKeys[0].pubkey || tx.transaction.message.accountKeys[0] }); } });
      }
      const mints = out.map(c => c.mint);
      const market = new Map();
      for (let i = 0; i < mints.length; i += 30) {
        try {
          const r = await fetch('https://api.dexscreener.com/tokens/v1/solana/' + mints.slice(i, i + 30).join(','));
          for (const p of await r.json()) { const m = p.baseToken.address; if (!market.has(m) || (p.liquidity?.usd || 0) > (market.get(m).liq || 0)) market.set(m, { symbol: p.baseToken.symbol, name: p.baseToken.name, image: p.info?.imageUrl || '', mcap: p.marketCap ?? p.fdv, vol24: p.volume?.h24, chg24: p.priceChange?.h24, liq: p.liquidity?.usd }); }
        } catch {}
      }
      return out.map(c => ({ ...c, ...(market.get(c.mint) || {}) }));
    });
    send(res, 200, { coins, live: true, at: Date.now() }, 15);
  } catch (e) { send(res, 502, { error: String(e.message || e) }, 5); }
}
