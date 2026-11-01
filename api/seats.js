import { isAddr, cached, send, firstBuyers, holdings } from './_read.js';

// Any pump.fun coin: its first 100 buyers (the seats Charter would give them) and who still holds.
export default async function handler(req, res) {
  const mint = req.query.mint;
  if (!isAddr(mint)) return send(res, 400, { error: 'mint' });
  try {
    const base = await cached('seats:' + mint, 6 * 3600e3, () => firstBuyers(mint));
    const meta = await cached('meta:' + mint, 600e3, async () => { try { const r = await fetch('https://lite-api.jup.ag/tokens/v2/search?query=' + mint); const t = (await r.json())[0]; return t?.id === mint ? { symbol: t.symbol, name: t.name, image: t.icon || '' } : {}; } catch { return {}; } });
    const live = await cached('hold:' + mint, 30e3, () => holdings(mint, base.seats.map(s => s.wallet)));
    const seats = base.seats.map((s, i) => ({ ...s, n: i + 1, now: live[i], holding: BigInt(live[i] || '0') > 0n }));
    send(res, 200, { mint, ...meta, launcher: base.launcher, seats, holding: seats.filter(s => s.holding).length, txScanned: base.txScanned, complete: base.complete, at: Date.now() }, 30);
  } catch (e) { send(res, 502, { error: String(e.message || e) }, 5); }
}
