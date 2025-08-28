# Using Pyth price feeds in an Anchor program

*(minimal guide; focuses on the “post update + use in the same transaction” flow)*

## Introduction

This guide shows how to consume a **Pyth** price inside a **Solana** program written with **Anchor**. We use the **Pyth Solana Receiver** “price update account” flow: the client posts a fresh, signed price update and, in the same transaction, calls your program, which verifies and reads that update.

## Prerequisites

- Rust, Solana CLI, and Anchor installed (Anchor ≥ 0.29 recommended)
- A devnet RPC URL (e.g., your QuickNode endpoint) and a funded devnet keypair
- The **feed ID (hex)** for the asset you want (e.g., ETH/USD)

## Project setup

Create a new Anchor workspace (or add to an existing one):
```bash
anchor new pyth-demo
cd pyth-demo
```

Add dependencies to `programs/pyth-demo/Cargo.toml`:
```toml
[dependencies]
anchor-lang = "0.29"
pyth-solana-receiver-sdk = "0.6"
# If you hit version friction with Solana crates, you can pin:
# pythnet-sdk = "~2.1"
```

Set your program id consistently (replace with yours):
- In `programs/pyth-demo/src/lib.rs`: `declare_id!("...");`
- In `Anchor.toml`:
  ```toml
  [programs.devnet]
  pyth_demo = "<YOUR_PROGRAM_ID>"

  [provider]
  cluster = "devnet"
  wallet = "~/.config/solana/id.json"
  ```

## Program code

Create `programs/pyth-demo/src/lib.rs`:

```rust
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{ get_feed_id_from_hex, PriceUpdateV2 };

declare_id!("11111111111111111111111111111111"); // replace with your program id

const MAX_AGE_SECS: u64 = 60;                    // freshness threshold
const FEED_ID_HEX: &str = "<PUT_FEED_ID_HEX>";   // e.g., ETH/USD feed id (hex)
const MAX_CONF_RATIO_BPS: u64 = 200;             // 2% conf/price cap (optional)

#[program]
pub mod pyth_demo {
    use super::*;

    pub fn read_price(ctx: Context<ReadPrice>) -> Result<()> {
        // Verify we are reading the intended asset
        let feed_id = get_feed_id_from_hex(FEED_ID_HEX)
            .map_err(|_| error!(ErrorCode::BadFeedId))?;

        // Enforce freshness and load the latest observation for that feed
        let p = ctx.accounts.price_update.get_price_no_older_than(
            &Clock::get()?, MAX_AGE_SECS, &feed_id
        )?;

        // Optional confidence bound: reject overly-uncertain prints
        require!(p.price != 0, ErrorCode::ZeroPrice);
        let abs_price = (p.price as i128).unsigned_abs() as u128;
        if abs_price > 0 {
            let conf_ratio_bps = (p.conf.saturating_mul(10_000)) / abs_price;
            require!(conf_ratio_bps <= MAX_CONF_RATIO_BPS as u128, ErrorCode::WideConfidence);
        }

        // Log raw integers for off-chain display (scale by 10^expo off-chain)
        msg!("price={}, conf={}, expo={}, t={}", p.price, p.conf, p.expo, p.publish_time);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ReadPrice<'info> {
    /// CHECK: Receiver SDK validates that this is a PriceUpdateV2 account
    pub price_update: Account<'info, PriceUpdateV2>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("invalid feed id")] BadFeedId,
    #[msg("price was zero")] ZeroPrice,
    #[msg("price confidence too wide")] WideConfidence,
}
```

**what to know**
- Programs don’t do HTTP. They read accounts that the client provides.
- `price`, `conf`, and `expo` are integers; display is `price * 10^expo` (and `conf * 10^expo`) **off-chain**.
- The “post + use” pattern guarantees the exact update your program used (atomic transaction).

## Client outline (post + use)

Use a short TypeScript or Rust client. The flow is the same:

1. **Fetch** a signed price update for your feed id (hex) from Pyth’s price service.
2. **Add Instruction A**: call the **Pyth Receiver** to **post** that update (writes a temporary `price_update` account).
3. **Add Instruction B**: call your program’s `read_price`, passing that `price_update` account.
4. **Send one transaction** (A then B). Read logs and scale to human-readable off-chain.

*(Use the current Receiver/Price Service client methods for your language; method names vary by version.)*

## Build and deploy

```bash
anchor build
anchor deploy --provider.cluster devnet
```

## Verify it works

- Run your client to post an update and invoke `read_price`.
- Check logs (e.g., `solana logs -u devnet`) for a line like:
  ```
  price=5854321000, conf=120000, expo=-8, t=1699999999
  ```
- Off-chain display: `5854321000 * 10^-8 = 58.54321000` (confidence `0.00120000`).

## Troubleshooting

- **program id mismatch**: keep `declare_id!`, `Anchor.toml`, and `target/deploy/*.json` in sync.
- **stale price**: fetch just before sending; adjust `MAX_AGE_SECS` if needed.
- **version friction**: pin the receiver/sdk versions as shown above.

## About price feed accounts (optional)

If you always want the latest price without posting an update each time, you can pass a **price feed account** (a stable address derived from *feed id + shard*) directly to your instruction. You still enforce freshness and confidence; an off-chain writer must keep that feed account updated. This guide focuses on the **price update account** flow because it is explicit and easy to reproduce on devnet.
