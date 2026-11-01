// POST /api/launch-tx {name, symbol, uri, user, devBuySol}
// -> {tx (base64 v0 VersionedTransaction, partially signed by the mint), mint, vault, version: 0}
// create + dev buy is ~1.45 KB as a plain tx, so it uses an address lookup table (env LAUNCH_LUT,
// made by the engine's `npm run lut`). Without LAUNCH_LUT only launches without a dev buy fit.
// One tx: ComputeBudget, pump.fun create_v2 (Token-2022, creator = vault), optional dev buy for the user,
// 0.01 SOL user -> TREASURY, Memo CHARTER|LAUNCH|<mint>|<vault>. User signs + sends with Phantom.
import { createRequire } from 'node:module';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import BN from 'bn.js';
import {
  send, fail, httpError, readJson, rpcUrl, loadVaults, usedVaults, isBase58Key, LAUNCH_FEE_LAMPORTS, MEMO_PROGRAM_ID,
} from './_chain.js';

// The SDK's ESM build breaks on Node (anchor named-export interop); its CJS build works.
const require = createRequire(import.meta.url);
const { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } = require('@pump-fun/pump-sdk');

const MAX_DEV_BUY_SOL = 5;
const CU_LIMIT = 400_000;
const CU_PRICE_MICROLAMPORTS = 200_000; // ~0.00008 SOL priority
const RESERVE_MS = 120_000;

// Vaults handed out by this warm instance recently (blockhash lifetime) so two users
// in the same 30 s cache window don't get the same vault.
const handedOut = new Map();

let lutCache = { at: 0, addr: null, table: null };
async function lookupTables(connection) {
  const addr = process.env.LAUNCH_LUT;
  if (!addr) return [];
  if (!isBase58Key(addr)) throw httpError(500, 'LAUNCH_LUT invalid');
  if (lutCache.table && lutCache.addr === addr && Date.now() - lutCache.at < 600_000) return [lutCache.table];
  const { value } = await connection.getAddressLookupTable(new PublicKey(addr));
  if (!value) throw httpError(500, 'LAUNCH_LUT not found on chain');
  lutCache = { at: Date.now(), addr, table: value };
  return [value];
}

let sdkCache = { at: 0, global: null, feeConfig: null };
async function pumpState(connection) {
  if (sdkCache.global && Date.now() - sdkCache.at < 60_000) return sdkCache;
  const online = new OnlinePumpSdk(connection);
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
  sdkCache = { at: Date.now(), global, feeConfig };
  return sdkCache;
}

export function validate(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const symbol = typeof body.symbol === 'string' ? body.symbol.trim().replace(/^\$/, '') : '';
  const uri = typeof body.uri === 'string' ? body.uri.trim() : '';
  const user = typeof body.user === 'string' ? body.user.trim() : '';
  if (!name || name.length > 32) throw httpError(400, 'name must be 1-32 chars');
  if (!/^[\p{L}\p{N}_.-]{1,10}$/u.test(symbol)) throw httpError(400, 'symbol must be 1-10 letters/numbers');
  if (uri.length > 200 || !/^https:\/\/[^\s]+$/.test(uri)) throw httpError(400, 'uri must be an https URL ≤ 200 chars');
  if (!isBase58Key(user)) throw httpError(400, 'user must be a base58 public key');
  let userKey;
  try { userKey = new PublicKey(user); } catch { throw httpError(400, 'invalid user key'); }
  if (!PublicKey.isOnCurve(userKey.toBytes())) throw httpError(400, 'user must be a wallet address');
  const raw = body.devBuySol ?? 0;
  const dev = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof dev !== 'number' || !Number.isFinite(dev) || dev < 0 || dev > MAX_DEV_BUY_SOL) throw httpError(400, `devBuySol must be 0-${MAX_DEV_BUY_SOL}`);
  const devLamports = Math.round(dev * 1e9);
  if (devLamports > 0 && devLamports < 1_000_000) throw httpError(400, 'devBuySol must be 0 or at least 0.001');
  return { name, symbol, uri, user: userKey, devLamports };
}

export async function pickVault(vaults, used, now = Date.now()) {
  for (const [v, exp] of handedOut) if (exp < now) handedOut.delete(v);
  const v = vaults.find((x) => !used.has(x) && !handedOut.has(x));
  if (!v) return null;
  handedOut.set(v, now + RESERVE_MS);
  return v;
}

/** Pure builder (no RPC) so it can be tested offline. */
export async function buildLaunchTx({ name, symbol, uri, user, devLamports, vault, treasury, mint, global, feeConfig, blockhash, luts = [] }) {
  const creator = new PublicKey(vault);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICROLAMPORTS }),
  ];
  if (devLamports > 0) {
    const solAmount = new BN(devLamports);
    const amount = getBuyTokenAmountFromSolAmount({
      global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: NATIVE_MINT,
    });
    ixs.push(...(await PUMP_SDK.createV2AndBuyInstructions({
      global, mint: mint.publicKey, name, symbol, uri, creator, user, amount, solAmount, mayhemMode: false,
    })));
  } else {
    ixs.push(await PUMP_SDK.createV2Instruction({ mint: mint.publicKey, name, symbol, uri, creator, user, mayhemMode: false }));
  }
  ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: new PublicKey(treasury), lamports: LAUNCH_FEE_LAMPORTS }));
  ixs.push(new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ID),
    keys: [{ pubkey: user, isSigner: true, isWritable: false }],
    data: Buffer.from(`CHARTER|LAUNCH|${mint.publicKey.toBase58()}|${vault}`, 'utf8'),
  }));
  let tx;
  try {
    const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(luts);
    tx = new VersionedTransaction(msg);
    tx.sign([mint]);
    const bytes = tx.serialize();
    if (bytes.length > 1232) throw new Error('too large');
    return Buffer.from(bytes).toString('base64');
  } catch (e) {
    if (devLamports > 0 && !luts.length) throw httpError(503, 'dev buy unavailable: LAUNCH_LUT not configured');
    throw httpError(500, `launch tx does not fit (${e.message})`);
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); throw httpError(405, 'POST only'); }
    const treasury = process.env.TREASURY;
    if (!isBase58Key(treasury)) throw httpError(500, 'TREASURY not configured');
    const input = validate(await readJson(req));

    const vaults = loadVaults();
    if (!vaults.length) throw httpError(503, 'pad full');
    const used = await usedVaults(treasury);
    const vault = await pickVault(vaults, used);
    if (!vault) throw httpError(503, 'pad full');

    const connection = new Connection(rpcUrl(), 'confirmed');
    const [{ global, feeConfig }, { blockhash }, luts] = await Promise.all([
      pumpState(connection),
      connection.getLatestBlockhash('confirmed'),
      lookupTables(connection),
    ]);
    const mint = Keypair.generate();
    const tx = await buildLaunchTx({ ...input, vault, treasury, mint, global, feeConfig, blockhash, luts });
    send(res, 200, { tx, mint: mint.publicKey.toBase58(), vault, version: 0 });
  } catch (e) {
    fail(res, e);
  }
}
