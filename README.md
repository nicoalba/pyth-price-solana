# Use Pyth price feeds in an Anchor program

Pyth is a first-party price oracle that aggregates trusted, low-latency quotes from top exchanges/market-makers and publishes onchain price feeds for a variety of asset classes, each with a price and confidence interval.

This tutorial shows you how to consume a [Pyth price](https://www.pyth.network/price-feeds) inside a Solana program written with Anchor. We use the [Pyth Solana Receiver](https://crates.io/crates/pyth-solana-receiver-sdk) *price update account* flow. In this flow, the client posts a fresh, signed price update and, in the same transaction, calls your program, which verifies and reads that update. For price feed accounts, see [Other methods](#other-methods).

- [Use Pyth price feeds in an Anchor program](#use-pyth-price-feeds-in-an-anchor-program)
  - [Prerequisites](#prerequisites)
    - [Get a QuickNode endpoint](#get-a-quicknode-endpoint)
    - [Version checks](#version-checks)
    - [Get your Pyth feed ID](#get-your-pyth-feed-id)
  - [Set up the project scaffold](#set-up-the-project-scaffold)
  - [Write the onchain program](#write-the-onchain-program)
  - [Build and deploy to devnet](#build-and-deploy-to-devnet)
  - [Run the client (post + use)](#run-the-client-post--use)
  - [Troubleshooting](#troubleshooting)
  - [Troubleshooting](#troubleshooting-1)
  - [Other methods](#other-methods)
    - [Use a price feed account](#use-a-price-feed-account)

## Prerequisites

>**Note**: 
- >If you're new to Solana or Anchor, review our [Solana fundamentals](https://www.quicknode.com/guides/solana-development/getting-started/solana-fundamentals-reference-guide) and [Intro to Anchor](https://www.quicknode.com/guides/solana-development/anchor/how-to-write-your-first-anchor-program-in-solana-part-1) guides.
>
- We have [a tutorial](https://www.quicknode.com/guides/solana-development/3rd-party-integrations/pyth-price-feeds) for Pyth price feeds using the [Solana Playground (web-based IDE)](https://beta.solpg.io/) for a zero-install experience, but fast-moving SDK/toolchain changes can cause version mismatches. This guide uses a local Anchor workspace for reproducibility.

Before you begin, ensure you have:

- Solana CLI (Agave) v2.x
- Rust toolchain via rustup: `rustup`, `rustc`, and `cargo`
- Anchor CLI 0.31.x
- Node 18+ and npm (for the client script)
- A devnet RPC URL (e.g., a QuickNode endpoint) and a funded devnet keypair
- The Pyth feed ID (64-char hex for the asset you want, e.g., ETH/USD).
- Devnet RPC URL and a funded devnet keypair (Recommended: QuickNode)

### Get a QuickNode endpoint

In your QuickNode dashboard:

1. Go to **Endpoints** → **+ New Endpoint**.
2. Select **Blockchain: Solana** → **Network: Devnet** → **Create**.
3. Copy the HTTP provider URL.

    ![QuickNode endpoint](pyth-demo/images/quicknode-endpoint.png)

### Version checks

Run these commands to ensure you're up to date:

```bash
solana --version
rustc --version
anchor --version 
cargo --version
rustup show active-toolchain
node --version 
npm --version
```
  
### Get your Pyth feed ID

1. Open [Pyth Insights: Price Feeds](https://insights.pyth.network/price-feeds).
2. Search for your asset.
3. Copy the Price Feed ID.
  
    For example, the feed ID for ETH/USD (used in this tutorial) is: `0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace`

## Set up the project scaffold

1. Create a new Anchor workspace (or add to an existing one), then `cd` into it:
    
    ```bash
    # Creates an Anchor workspace with TypeScript test and npm as the package manager
    anchor init pyth-demo --package-manager npm
    cd pyth-demo
    ```

2. Add dependencies to `programs/pyth-demo/Cargo.toml`:

    ```toml
    [dependencies]
    anchor-lang = "0.31.1"
    pyth-solana-receiver-sdk = "0.6.1"

    # TEMP pin: SBF toolchain can't compile base64ct ≥ 1.8 (Rust 2024).
    base64ct = "=1.7.3"   # remove once the SBF toolchain ships rustc ≥ 1.85
    ```

    Do *not* add `solana-program` manually; Anchor pins the right version for you.

3. Target devnet in `Anchor.toml`:
    
    1. If your `[provider]` block says `cluster = "localnet"`, switch it to devnet with this command:

        ```bash
        sed -i 's/^cluster = "localnet"/cluster = "devnet"/' Anchor.toml || true
        ```

    2. Point your Solana CLI at your [QuickNode devnet URL](#get-a-quicknode-endpoint):

        ```bash
        solana config set --url https://<insert-your-quicknode-devnet-url>
        ```

4. Lock toolchain and confirm PATH (prevents version mismatch errors):

    1. Update `anchor.toml`

        ```toml
        [toolchain]
        anchor_version = "0.31.1"
        solana_version = "2.3.8"   # Agave (known-good)
        package_manager = "npm"
        ```
    
    2. Verify versions:

        ```bash
        solana --version   # expect 2.3.x
        anchor --version   # expect 0.31.1
        ```

        If these match, move on to Step 5. If they don't, see [Troubleshooting → Toolchain/PATH mismatch](#troubleshooting).

5. Set your program ID:

    A program ID is your program's onchain address (pubkey) derived from: `target/deploy/pyth_demo-keypair.json`. It must match in *both*:
    
    - `programs/pyth-demo/src/lib.rs` -> `declare_id!("...");`
    - `Anchor.toml` -> `[programs.devnet] pyth_demo = "..."`

    1. Build once to create the deploy artifacts:
        
        ```bash
        anchor build
        ```

    2. Get your Program ID (pubkey derived from the generated keypair):

        ```bash
        solana address -k target/deploy/pyth_demo-keypair.json
        ```
    
    3. Set the ID in `programs/pyth-demo/src/lib.rs` manually:

        ```rust
        // programs/pyth-demo/src/lib.rs
        declare_id!("PASTE_THE_PUBKEY_YOU_JUST_PRINTED");
        ```

    4. Set the ID in `Anchor.toml` automatically:

        ```bash
        anchor keys sync
        ```
    5. Rebuilt and confirm:

        ```bash
        anchor build
        anchor keys list   # confirm pyth_demo on devnet matches declare_id! and the keypair pubkey
        ```

## Write the onchain program

1. Create `programs/pyth-demo/src/lib.rs`:

    ```rust
    use anchor_lang::prelude::*;
    use pyth_solana_receiver_sdk::price_update::{ get_feed_id_from_hex, PriceUpdateV2 };

    declare_id!("11111111111111111111111111111111"); // replace with your program ID

    const MAX_AGE_SECS: u64 = 60;                    // freshness threshold
    const FEED_ID_HEX: &str = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";   // e.g., ETH/USD feed ID (hex)
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
            let abs_price = p.price.unsigned_abs() as u128;
            if abs_price > 0 {
                let conf_ratio_bps = (p.conf.saturating_mul(10_000)) / abs_price;
                require!(conf_ratio_bps <= MAX_CONF_RATIO_BPS as u128, ErrorCode::WideConfidence);
            }

            // Log raw integers for offchain display (scale by 10^expo offchain)
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
        #[msg("invalid feed ID")] BadFeedId,
        #[msg("price was zero")] ZeroPrice,
        #[msg("price confidence too wide")] WideConfidence,
    }
    ```

> **Note**:
> 
>- Programs don't do HTTP. They read accounts that the client provides.
>- `price`, `conf`, and `expo` are integers; display is `price * 10^expo` (and `conf * 10^expo`) offchain.
>- The "post + use" pattern guarantees the exact update your program used (atomic transaction).

## Build and deploy to devnet

1. Point Solana at your devnet RPC:

  ```bash
  solana config set --url https://<your-devnet-rpc>
  ```

2. Run build and deploy:

    ```bash
    anchor build
    anchor deploy --provider.cluster devnet
    ```

## Run the client (post + use)

1. Create a client folder and install dependencies:

    ```bash
    mkdir -p client && cd client
    npm init -y
    npm i -D typescript ts-node
    npm i @solana/web3.js @coral-xyz/anchor @pythnetwork/hermes-client @pythnetwork/pyth-solana-receiver @pythnetwork/solana-utils
    ```

2. Set environment variables (example):

    ```bash
    export SOLANA_RPC_URL="https://<your-devnet-rpc>"   # e.g., your QuickNode devnet URL
    export PROGRAM_ID="<your-program-id>"               # from `anchor deploy`
    export PYTH_FEED_ID_HEX="0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"     # the same feed ID you set in FEED_ID_HEX
    export PAYER_KEYPAIR="~/.config/solana/id.json"     # path to your devnet keypair
    ```

3. Create `client-post-and-use.ts` with this minimal script:

    ```ts
    // client-post-and-use.ts
    // Minimal client: fetch Pyth update → post via Receiver → call your program in the same txn.
    import fs from "fs";
    import path from "path";
    import { Connection, Keypair, PublicKey } from "@solana/web3.js";
    import { AnchorProvider, Wallet, Program, Idl } from "@coral-xyz/anchor";
    import { HermesClient } from "@pythnetwork/hermes-client";
    import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
    import { sendTransactions } from "@pythnetwork/solana-utils";

    async function main() {
      // --- env ---
      const rpc = process.env.SOLANA_RPC_URL!;
      const programId = new PublicKey(process.env.PROGRAM_ID!);
      const feedIdHex = process.env.PYTH_FEED_ID_HEX!;
      const keypath = process.env.PAYER_KEYPAIR ?? path.join(process.env.HOME!, ".config/solana/id.json");
      const idlBase = process.env.PROGRAM_IDL_BASENAME ?? "pyth_demo"; // ../target/idl/<name>.json
      const idlPath = path.join(__dirname, `../target/idl/${idlBase}.json`);

      // --- setup (connection, wallet, program) ---
      const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypath, "utf8"))));
      const connection = new Connection(rpc, "confirmed");
      const provider = new AnchorProvider(connection, new Wallet(payer), {});
      const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
      const program = new Program(idl, programId, provider);

      // --- 1) fetch signed update offchain (Hermes) ---
      const hermes = new HermesClient("https://hermes.pyth.network");
      const updates = await hermes.getLatestPriceUpdates([feedIdHex]);
      if (!updates.length) throw new Error("No price updates");
      const signedUpdate = updates[0];

      // --- 2) one transaction: post update → call your program ---
      const receiver = new PythSolanaReceiver({ connection, wallet: provider.wallet });
      const txb = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
      await txb.addPostPriceUpdates(signedUpdate); // A) post (creates temp price_update account)
      await txb.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
        const priceUpdatePk = getPriceUpdateAccount(feedIdHex);
        const ix = await program.methods.readPrice().accounts({ priceUpdate: priceUpdatePk }).instruction();
        return [{ instruction: ix, signers: [] }]; // B) use (your Anchor instruction)
      });

      // --- 3) send ---
      const txs = await txb.buildVersionedTransactions({});
      await sendTransactions(txs, connection, provider.wallet);
      console.log("posted + used Pyth update in one transaction");
    }

    main().catch((e) => { console.error(e); process.exit(1); });

    ```

4. Run the client:

    ```bash
    npx ts-node client-post-and-use.ts
    ```

5. Check logs:

    ```bash
    solana logs -u devnet
    ```

    You should see a line like:
    
    ```
    price=5854321000, conf=120000, expo=-8, t=1699999999
    ```

    Offchain display: `5854321000 * 10^-8 = 58.54321000` (confidence `0.00120000`).
   
## Troubleshooting

- **Program ID mismatch**: Keep `declare_id!`, `Anchor.toml`, and `target/deploy/*.json` in sync.
- **Stale price**: Fetch just before sending; adjust `MAX_AGE_SECS` if needed.
- **Version friction**: Pin the receiver/sdk versions as shown above.

## Troubleshooting

Encountering issues? Here are common problems and solutions:

- **Edition 2024 / base64ct error**: After pinning `base64ct = "=1.7.3"` in `programs/pyth-demo/Cargo.toml`, force the lockfile to respect it: `cargo update -p base64ct --precise 1.7.3 && anchor build`; if it still fails, reset and rebuild: `rm -f Cargo.lock && anchor build`; verify with `cargo tree -i base64ct` (should show 1.7.3). Remove the pin once the SBF toolchain ships rustc ≥ 1.85.
- **Toolchain/PATH mismatch**: If `solana --version` isn’t 2.3.x or `anchor --version` isn’t 0.31.1, your shell isn't picking up Solana'’'s active release. Fix for bash:
  - Fix for bash:
    
    ```bash
    export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
    grep -qxF 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' ~/.bashrc || \
    echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.bashrc
    exec bash -l
    ```

    Then re-check with `solana --version` and `anchor --version`.

  - If Anchor is still off, align it with:

    ```bash
    npm i -g @coral-xyz/anchor-cli@0.31.1
    anchor --version
    ```

- **Program ID mismatch**: Ensure `declare_id!` in `lib.rs`, `Anchor.toml`, and `target/deploy/pyth_demo.json` match. Run `anchor build` and check `target/deploy/`.
- **Stale price errors**: If `get_price_no_older_than` fails, verify Hermes returns fresh data. Increase `MAX_AGE_SECS` (e.g., to 120) for devnet latency. Use QuickNode’s low-latency RPC: [QuickNode Devnet Endpoint](https://www.quicknode.com/endpoints).
- **Dependency Conflicts**: If `cargo build` fails, run `cargo tree -i solana-program` to check for version mismatches. Pin `pythnet-sdk = "~2.1"` if needed.
- **Hermes Failures**: If no price updates are returned, retry after 1-2 seconds or use `https://hermes-beta.pyth.network`. Check QuickNode’s log dashboard for RPC errors: [QuickNode Logs](https://www.quicknode.com/docs/solana/logs).

## Other methods

### Use a price feed account

If you always want the latest price without posting an update each time, you can pass a *price feed account* (a stable address derived from *feed ID + shard*) directly to your instruction. You still enforce freshness and confidence; an offchain writer must keep that feed account updated. This guide focuses on the *price update account* flow because it is explicit and easy to reproduce on devnet.
