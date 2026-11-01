import { cached, send } from './_read.js';

// pump.fun coins with the most volume in the last hour (Jupiter), to try the seat check on.
export default async function handler(req, res) {
  try {
    const list = await cached('runners', 60e3, async () => {
      const r = await fetch('https://lite-api.jup.ag/tokens/v2/toptraded/1h?limit=100');
      const j = await r.json();
      return j.filter(t => /pump/i.test(t.launchpad || '')).slice(0, 16).map(t => ({ mint: t.id, symbol: t.symbol, name: t.name, image: t.icon || '', mcap: t.mcap, vol1h: (t.stats1h?.buyVolume || 0) + (t.stats1h?.sellVolume || 0), holders: t.holderCount, created: t.firstPool?.createdAt }));
    });
    send(res, 200, { coins: list, at: Date.now() }, 60);
  } catch (e) { send(res, 502, { error: String(e.message || e) }, 5); }
}
