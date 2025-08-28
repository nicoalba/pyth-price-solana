# Use Pyth price feeds on Solana with Anchor

This tutorial shows how to read Pyth prices inside a Solana program (Anchor) using the modern *Pyth Solana Receiver* pattern. You'll verify freshness (staleness), interpret price *exponent (decimals)* and *confidence intervals*, and print a human‑readable value off‑chain.

## Table of contents
- [Use Pyth price feeds on Solana with Anchor](#use-pyth-price-feeds-on-solana-with-anchor)
  - [Table of contents](#table-of-contents)
  - [Introduction](#introduction)
  - [Prerequisites](#prerequisites)
  - [Project Setup](#project-setup)
  - [Program Code (Rust)](#program-code-rust)
  - [Build, Deploy, and Run](#build-deploy-and-run)
  - [How to Supply a `price_update` Account](#how-to-supply-a-price_update-account)
    - [Option A: Price Update Account (pull oracle)](#option-a-price-update-account-pull-oracle)
    - [Option B: Price Feed Account (always-latest)](#option-b-price-feed-account-always-latest)
  - [Verify It Works](#verify-it-works)
  - [Troubleshooting](#troubleshooting)
  - [Next steps](#next-steps)
  - [Reference repo (optional)](#reference-repo-optional)
    - [Submission tips](#submission-tips)

## Introduction

You'll build a minimal Anchor program that **reads a Pyth price** from an account passed in as an instruction account, performs **freshness** and **confidence** checks, and logs the **raw price** along with its **exponent**. Off‑chain, you'll scale the integer `price` by `10^expo` to display a human‑readable float (never do float math on-chain).

**Why this matters:** Real protocols gate actions on *fresh, trustworthy* data. Demonstrating **staleness**, **confidence**, and **decimal scaling** shows production‑minded thinking rather than “print the number.”

## Prerequisites

- **Toolchain**
  - Rust + cargo
  - Solana CLI
  - Anchor (v0.29+ recommended)
- **RPC**: devnet RPC URL (your QuickNode endpoint works great), or localnet validator
- **Price feed ID**: a Pyth price feed you want to read (e.g., BTC/USD). You'll paste its **hex feed ID** into the program (see notes in the code).

> **Version tip:** Pin exact crate versions if you hit compatibility warnings. The code below shows example version specs; update to the latest stable per your environment.

## Project Setup
Create a fresh Anchor workspace (or add to an existing one):
```bash
anchor new pyth-demo
cd pyth-demo
```

Add dependencies to `programs/pyth-demo/Cargo.toml`:
```toml
[dependencies]
anchor-lang = "0.29"
# Receiver SDK for reading/update verification
pyth-solana-receiver-sdk = "0.6"
# If you see a Solana/Anchor version tug-of-war, try pinning:
# pythnet-sdk = "~2.1"
```

Ensure `Anchor.toml` has consistent Program ID entries and clusters:
```toml
[programs.localnet]
pyth_demo = "11111111111111111111111111111111" # REPLACE with your program id

[programs.devnet]
pyth_demo = "11111111111111111111111111111111" # REPLACE with your program id

[provider]
cluster = "devnet"  # switch to "localnet" when needed
wallet = "~/.config/solana/id.json"
```

> **Gotcha:** Your Program ID must match across: `declare_id!` in `lib.rs`, `Anchor.toml`, and the keypair under `target/deploy/`. Re-run `anchor keys list` and update all three if needed.

## Program Code (Rust)
Create `programs/pyth-demo/src/lib.rs`:

```rust
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{ get_feed_id_from_hex, PriceUpdateV2 };

declare_id!("11111111111111111111111111111111"); // REPLACE with your program id

// Reject prices older than this (seconds)
const MAX_AGE_SECS: u64 = 60;

// Pyth feed ID in hex (example: BTC/USD). Replace with your chosen feed's ID.
const FEED_ID_HEX: &str = "<PUT_PRICE_FEED_ID_HEX_HERE>";

// Optional: cap confidence relative to price, e.g., conf <= 2% of |price|
// Adjust logic as needed for your use-case.
const MAX_CONF_RATIO_BPS: u64 = 200; // 200 bps = 2%

#[program]
pub mod pyth_demo {
    use super::*;

    pub fn read_price(ctx: Context<ReadPrice>) -> Result<()> {
        // Parse the target feed id (fails if the hex is malformed)
        let feed_id = get_feed_id_from_hex(FEED_ID_HEX)
            .map_err(|_| error!(ErrorCode::BadFeedId))?;

        // Enforce freshness: returns the latest price newer than MAX_AGE_SECS
        let p = ctx.accounts.price_update.get_price_no_older_than(
            &Clock::get()?, MAX_AGE_SECS, &feed_id
        )?;

        // p has fields: price (i64), conf (u128), expo (i32), publish_time (i64)
        // Raw integer values at exponent 'expo' (scale by 10^expo off-chain for display).
        msg!("pyth price raw: price={}, conf={}, expo={}, t={}",
             p.price, p.conf, p.expo, p.publish_time);

        // Optional: basic confidence guard (e.g., conf <= 2% of |price|)
        // Convert price to positive u128 for comparison.
        let abs_price = (p.price as i128).unsigned_abs() as u128;
        if abs_price > 0 {
            let conf_ratio_bps = (p.conf * 10_000) / abs_price;
            require!(conf_ratio_bps <= MAX_CONF_RATIO_BPS as u128, ErrorCode::WideConfidence);
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct ReadPrice<'info> {
    /// CHECK: Receiver SDK validates the account type/discriminator internally
    pub price_update: Account<'info, PriceUpdateV2>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid feed id")]
    BadFeedId,
    #[msg("Price confidence too wide")]
    WideConfidence,
}
```

**Key points:**

- **Staleness:** `get_price_no_older_than` enforces freshness (`MAX_AGE_SECS`).
- **Decimals:** Price is an integer at `expo`; display value = `price * 10^expo` (do off‑chain).
- **Confidence:** Treat `price ± conf` as the plausible band. The ratio guard is optional but production-friendly.
- **Validation:** By passing a known **feed ID** you ensure you're reading the intended asset, not a spoofed account.

---

## Build, Deploy, and Run

```bash
# 0) Set your program id consistently (lib.rs, Anchor.toml, keypair)
anchor keys list

# 1) Build
anchor build

# 2) (Optional) Localnet
solana-test-validator -r --ledger ~/.solana-ledgers/demo
anchor deploy --provider.cluster localnet

# 3) Devnet (recommended for Pyth feeds)
anchor deploy --provider.cluster devnet
```

> **Note:** For devnet, ensure your wallet is funded and your RPC URL is set (e.g., QuickNode).

## How to Supply a `price_update` Account

You have two common patterns:

### Option A: Price Update Account (pull oracle)

1. Your client fetches a signed **price update** for your `FEED_ID_HEX` (e.g., from Pyth's “Hermes” service).
2. The client **posts** that update to Solana via the **Receiver**, which writes it into a short‑lived **price_update** account.
3. You pass that account pubkey to your `read_price` instruction.

**Pros:** fresh and explicit; good for “this tx used price X at time T”.  
**Cons:** needs an extra client step each time you invoke your program.

**(Pseudo) TypeScript outline:**

```ts
// npm i @solana/web3.js @coral-xyz/anchor
// plus the current Pyth client libs for fetching updates & posting via Receiver

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
// import Pyth client(s) to fetch price updates (check current package names/docs)

const feedIdHex = "<PUT_PRICE_FEED_ID_HEX_HERE>";
const conn = new Connection(process.env.QUICKNODE_DEVNET_HTTPS!, "confirmed");
const payer = Keypair.fromSecretKey(/* ... */);

// 1) Fetch signed updates for feedIdHex
// const updates = await priceService.getPriceUpdates([feedIdHex]);

// 2) Post updates via Receiver to create a price_update account
// const ix = await receiver.postPriceUpdates(updates.binary.data, payer.publicKey);
// const sig = await receiver.sendAndConfirm([ix], [payer]);
// const priceUpdatePk = /* derive or read from logs */;

// 3) Call your Anchor program, passing { price_update: priceUpdatePk }
```

> **Fill in current client library calls** per the latest Pyth Receiver/Price Service docs (method names may differ by version).

### Option B: Price Feed Account (always-latest)

The Receiver can maintain **price feed accounts** at stable addresses (derived from **feed ID** + shard). You pass the feed account pubkey to your instruction, and the program reads the latest price directly.

**Pros:** simple when you just want the current price.  
**Cons:** less explicit about “which update” you used; still verify staleness.

## Verify It Works
1. **Deploy** your program on devnet.  
2. **Provide** either a `price_update` account (Option A) or a live **price feed account** (Option B).  
3. **Invoke** `read_price`.  
4. **Check logs**:
    
    ```
    pyth price raw: price=5854321000, conf=120000, expo=-8, t=1699999999
    ```

5. **Scale off-chain** for display: `human = price * 10^expo`.  
    
    - Example above: `5854321000 * 10^-8 = 58.54321`

## Troubleshooting

- **Program ID mismatch**: Make sure `declare_id!`, `Anchor.toml`, and `target/deploy/<program>-keypair.json` all correspond.
- **Version conflicts (Solana/Anchor/Pyth)**: Pin crates as noted; try aligning Solana crate versions pulled by dependencies.
- **Stale price**: Increase `MAX_AGE_SECS` or ensure your client posted a fresh update just before invoking your program.
- **Wrong feed**: Double‑check the **feed ID hex** and/or the feed account address for devnet vs mainnet.
- **Logging**: Use `solana logs -u devnet` to tail program output.

## Next steps

- Add a stronger **confidence ratio guard** or absolute confidence threshold.
- Emit a parsed, scaled price as an **event** to make off‑chain indexing easier.
- Demonstrate a tiny listener using WebSocket `accountSubscribe` (or QuickNode Streams) to watch feed accounts in real time.
- Add an **Anchor test** that injects a mock price account and asserts staleness/ratio checks.

## Reference repo (optional)

Include a one‑line link to a minimal repo if you create one for the grader's convenience (but keep this README **self‑contained** for Gist submission).
- https://github.com/<you>/<pyth-demo> (optional)

### Submission tips

- Paste this README into a **Public GitHub Gist** as `README.md` and submit that URL.
- Keep commands **copy‑perfect** and include expected output in **Verify It Works**.
- Use placeholders for secrets (never paste real keys).
