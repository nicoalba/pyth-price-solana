"use strict";
// client/client-post-and-use.ts
// Fetch Pyth update (HTTP) → post via Receiver → call your program (manual Anchor ix) → print on-chain logs + human-readable price.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const web3_js_1 = require("@solana/web3.js");
const anchor_1 = require("@coral-xyz/anchor");
const pyth_solana_receiver_1 = require("@pythnetwork/pyth-solana-receiver");
const crypto_1 = require("crypto");
function requireEnv(name) {
    const v = process.env[name];
    if (!v)
        throw new Error(`Missing env var: ${name}`);
    return v;
}
// Anchor discriminator: first 8 bytes of sha256("global:<method>")
function anchorSighashGlobal(name) {
    const h = (0, crypto_1.createHash)("sha256").update(`global:${name}`).digest();
    return h.subarray(0, 8);
}
// Hermes v2 (with legacy fallback) → return base64 updates (string[])
async function fetchPythUpdates(feedIdHex) {
    const base = process.env.HERMES_URL ?? "https://hermes.pyth.network";
    // v2 endpoint first
    let url = new URL("/v2/updates/price/latest", base);
    url.searchParams.set("ids[]", feedIdHex);
    url.searchParams.set("encoding", "base64");
    url.searchParams.set("chain", "solana");
    url.searchParams.set("cluster", "devnet");
    let res = await fetch(url.toString());
    if (res.status === 404) {
        // legacy fallback
        url = new URL("/api/latest_price_updates", base);
        url.searchParams.set("ids[]", feedIdHex);
        url.searchParams.set("parsed", "false");
        res = await fetch(url.toString());
    }
    if (!res.ok)
        throw new Error(`Hermes HTTP ${res.status}`);
    const body = await res.json();
    if (body?.binary?.data && Array.isArray(body.binary.data))
        return body.binary.data;
    if (body?.data?.binary?.data && Array.isArray(body.data.binary.data))
        return body.data.binary.data;
    if (Array.isArray(body?.updates) && body.updates[0]?.binary?.data)
        return body.updates[0].binary.data;
    if (Array.isArray(body) && body[0]?.binary?.data)
        return body[0].binary.data;
    if (Array.isArray(body?.updates) && typeof body.updates[0] === "string")
        return body.updates;
    throw new Error("Hermes response missing base64 updates (binary.data)");
}
// helpers to pretty-print integers scaled by 10^exponent
function formatScaled(intStr, exponent) {
    let sign = "";
    if (intStr.startsWith("-")) {
        sign = "-";
        intStr = intStr.slice(1);
    }
    if (exponent >= 0)
        return sign + intStr + "0".repeat(exponent);
    const places = -exponent;
    if (intStr.length <= places) {
        return sign + "0." + "0".repeat(places - intStr.length) + intStr;
    }
    const split = intStr.length - places;
    return sign + intStr.slice(0, split) + "." + intStr.slice(split);
}
function bpsToPercent(confStr, priceStr) {
    try {
        const conf = BigInt(confStr);
        const priceAbs = (priceStr.startsWith("-") ? BigInt(priceStr.slice(1)) : BigInt(priceStr)) || 1n;
        const bps = (conf * 10000n) / priceAbs;
        // show to two decimals
        const whole = bps / 100n;
        const frac = (bps % 100n).toString().padStart(2, "0");
        return `${whole}.${frac}%`;
    }
    catch {
        return "~";
    }
}
// Print logs and a human-readable price line if present
async function printProgramLogs(connection, sig, label = "ETH/USD") {
    const tx = await connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
    });
    const logs = tx?.meta?.logMessages ?? [];
    for (const line of logs) {
        if (line.startsWith("Program log:"))
            console.log(line);
    }
    // Try to parse: price=..., conf=..., exponent=..., t=...
    const priceLine = logs.find((l) => l.includes("price=") && l.includes("exponent="));
    if (priceLine) {
        const m = priceLine.match(/price=(-?\d+), conf=(\d+), (?:expo|exponent)=(-?\d+), t=(\d+)/);
        if (m) {
            const [, priceI, confI, expoI, tSec] = m;
            const displayPrice = formatScaled(priceI, parseInt(expoI, 10));
            const displayConf = formatScaled(confI, parseInt(expoI, 10));
            const confPct = bpsToPercent(confI, priceI);
            const when = new Date(Number(tSec) * 1000).toISOString();
            console.log(`Display ${label}: ${displayPrice} (±${displayConf}, ~${confPct}) @ ${when}`);
        }
    }
}
async function main() {
    // --- env ---
    const rpc = requireEnv("SOLANA_RPC_URL");
    const programId = new web3_js_1.PublicKey(requireEnv("PROGRAM_ID"));
    const feedIdHex = requireEnv("PYTH_FEED_ID_HEX");
    const keypath = process.env.PAYER_KEYPAIR ?? path.join(process.env.HOME || "", ".config/solana/id.json");
    // --- setup ---
    const payer = web3_js_1.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypath, "utf8"))));
    const connection = new web3_js_1.Connection(rpc, "confirmed");
    const provider = new anchor_1.AnchorProvider(connection, new anchor_1.Wallet(payer), {});
    // --- 1) fetch signed update (Hermes over HTTP) ---
    const priceUpdateData = await fetchPythUpdates(feedIdHex);
    if (priceUpdateData.length === 0)
        throw new Error("No price updates from Hermes");
    // --- 2) one transaction: post update → call your program ---
    const receiver = new pyth_solana_receiver_1.PythSolanaReceiver({ connection, wallet: provider.wallet });
    const txb = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
    // A) post (creates temp PriceUpdateV2 account)
    await txb.addPostPriceUpdates(priceUpdateData);
    // B) use (manual Anchor instruction for read_price())
    await txb.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
        const priceUpdatePk = getPriceUpdateAccount(feedIdHex);
        // read_price has no args → data = 8-byte discriminator only
        const data = anchorSighashGlobal("read_price");
        const ix = new web3_js_1.TransactionInstruction({
            programId,
            keys: [{ pubkey: priceUpdatePk, isSigner: false, isWritable: false }],
            data,
        });
        return [{ instruction: ix, signers: [] }];
    });
    // --- 3) build, sign, send, confirm + print logs + human-readable price ---
    const built = await txb.buildVersionedTransactions({});
    for (const { tx, signers } of built) {
        tx.sign([payer, ...(signers || [])]);
        const sig = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            maxRetries: 3,
        });
        await connection.confirmTransaction(sig, "confirmed");
        console.log("tx:", sig);
        await printProgramLogs(connection, sig, "ETH/USD");
    }
    console.log("Success: posted + used Pyth update in one transaction");
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
