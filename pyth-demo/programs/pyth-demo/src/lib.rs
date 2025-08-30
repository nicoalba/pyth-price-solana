use anchor_lang::prelude::*;

declare_id!("7DJXqHoma1rG9soqjMCyL1h9tGiDLJKHfbee3wTowthS");

#[program]
pub mod pyth_demo {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
