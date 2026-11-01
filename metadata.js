// POST /api/metadata — upload image + pump.fun metadata JSON to Filebase IPFS.
// Body: JSON {image: dataURL, name, symbol, description, twitter, website, telegram}
//   or multipart/form-data with the same fields (image as a file or data URL).
// Returns {uri, image}.
import { send, fail, httpError, readRaw, readJson } from './_chain.js';

const MAX_IMAGE = 2 * 1024 * 1024;
const FILEBASE_ADD = 'https://rpc.filebase.io/api/v0/add?cid-version=1';
const GATEWAY = 'https://ipfs.filebase.io/ipfs/';
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function decodeDataUrl(s) {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(s || ''));
  if (!m) throw httpError(400, 'image must be a base64 data URL');
  if (m[2].length > Math.ceil(MAX_IMAGE / 3) * 4 + 8) throw httpError(413, 'image over 2 MB');
  return Buffer.from(m[2], 'base64');
}

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

function str(v, field, max, { required = false, min = 0 } = {}) {
  const s = clean(v);
  if (required && !s) throw httpError(400, `${field} required`);
  if (s.length > max || s.length < min) throw httpError(400, `${field} must be ${min}-${max} chars`);
  if (/[\u0000-\u001f\u007f]/.test(s.replace(/\n/g, ''))) throw httpError(400, `${field} has control characters`);
  return s;
}

function link(v, field, hosts) {
  const s = clean(v);
  if (!s) return undefined;
  if (s.length > 200) throw httpError(400, `${field} too long`);
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { throw httpError(400, `${field} is not a URL`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw httpError(400, `${field} must be http(s)`);
  if (hosts && !hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) throw httpError(400, `${field} must be on ${hosts.join(' / ')}`);
  return u.toString();
}

async function readInput(req) {
  const ct = String(req.headers['content-type'] || '');
  if (ct.startsWith('multipart/form-data')) {
    const raw = await readRaw(req, MAX_IMAGE + 512 * 1024);
    const form = await new Response(raw, { headers: { 'content-type': ct } }).formData();
    const out = {};
    for (const [k, v] of form.entries()) {
      if (k === 'image' && typeof v !== 'string') out.imageBuf = Buffer.from(await v.arrayBuffer());
      else out[k] = v;
    }
    return out;
  }
  return readJson(req, Math.ceil(MAX_IMAGE * 1.4) + 64 * 1024);
}

async function ipfsAdd(buf, filename, type) {
  const token = process.env.FILEBASE_IPFS_TOKEN;
  if (!token) throw httpError(500, 'FILEBASE_IPFS_TOKEN not set');
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), filename);
  const r = await fetch(FILEBASE_ADD, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  const text = await r.text();
  if (!r.ok) throw httpError(502, `ipfs upload failed (${r.status})`);
  // Response may be NDJSON (one line per file); take the last line with a Hash.
  const line = text.trim().split('\n').reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.Hash || j?.cid);
  const cid = line?.Hash || line?.cid;
  if (!cid) throw httpError(502, 'ipfs upload returned no CID');
  return `${GATEWAY}${cid}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); throw httpError(405, 'POST only'); }
    const body = await readInput(req);

    const name = str(body.name, 'name', 32, { required: true });
    const symbol = str(body.symbol, 'symbol', 10, { required: true }).replace(/^\$/, '');
    if (!/^[\p{L}\p{N}_.-]{1,10}$/u.test(symbol)) throw httpError(400, 'symbol: letters/numbers only, max 10');
    const description = str(body.description, 'description', 1000);
    const twitter = link(body.twitter, 'twitter', ['x.com', 'twitter.com']);
    const website = link(body.website, 'website');
    const telegram = link(body.telegram, 'telegram', ['t.me', 'telegram.me']);

    const img = body.imageBuf || decodeDataUrl(body.image);
    if (!img.length) throw httpError(400, 'image required');
    if (img.length > MAX_IMAGE) throw httpError(413, 'image over 2 MB');
    const type = sniff(img);
    if (!type) throw httpError(415, 'image must be png, jpg, gif or webp');

    const image = await ipfsAdd(img, `image.${TYPES[type]}`, type);
    const site = (process.env.SITE_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host || 'charter.fun'}`).replace(/\/$/, '');
    const meta = { name, symbol, description, image, showName: true, createdOn: site };
    if (twitter) meta.twitter = twitter;
    if (website) meta.website = website;
    if (telegram) meta.telegram = telegram;
    const uri = await ipfsAdd(Buffer.from(JSON.stringify(meta)), 'metadata.json', 'application/json');

    send(res, 200, { uri, image });
  } catch (e) {
    fail(res, e);
  }
}
