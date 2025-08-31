use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{ get_feed_id_from_hex, PriceUpdateV2 };

declare_id!("11111111111111111111111111111111"); // replace with your program ID

const MAX_AGE_SECS: u64 = 60; // freshness threshold
const FEED_ID_HEX: &str = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"; // e.g., ETH/USD feed ID (hex)
const MAX_CONF_RATIO_BPS: u64 = 200; // 2% conf/price cap (optional)

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
        let abs_price: u128 = p.price.unsigned_abs() as u128;
        if abs_price > 0 {
            // do math in u128 to avoid u64/u128 divide errors
            let conf_ratio_bps: u128 = (u128::from(p.conf) * 10_000) / abs_price;
            require!(
                conf_ratio_bps <= u128::from(MAX_CONF_RATIO_BPS),
                ErrorCode::WideConfidence
            );
        }

        // Log raw integers for offchain display (scale by 10^exponent offchain)
        msg!(
            "price={}, conf={}, exponent={}, t={}",
            p.price,
            p.conf,
            p.exponent,
            p.publish_time
        );

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
    #[msg("invalid feed ID")]
    BadFeedId,
    #[msg("price was zero")]
    ZeroPrice,
    #[msg("price confidence too wide")]
    WideConfidence,
}
