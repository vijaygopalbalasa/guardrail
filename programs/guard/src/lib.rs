//! Guardrail: limits your AI trading agent cannot break.
//!
//! The guard PDA is the delegate of a user's Velocity perps account. The agent key can trade only by calling this
//! program; every order is checked against limits the owner froze on chain, and an order that breaks one is refused
//! with its reason. The guard exposes only place_perp_order and cancel_order to the agent; there is no withdraw.

use anchor_lang::prelude::*;

pub mod math;
pub mod velocity;

declare_id!("BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy");

/// Number of per-market rows in the limits table (the G2 allowlist and the G4 caps).
pub const MAX_MARKETS: usize = 8;

/// Rule codes carried by every OrderChecked event.
pub mod rule {
    pub const ACCEPTED: u8 = 0;
    pub const G1_ORDER_SIZE: u8 = 1;
    pub const G2_ALLOWLIST: u8 = 2;
    pub const G3_DAILY_NOTIONAL: u8 = 3;
    pub const G4_EXPOSURE: u8 = 4;
    pub const G5_LEVERAGE: u8 = 5;
    pub const G6_PRICE_BAND: u8 = 6;
    pub const G7_PAUSED: u8 = 7;
    pub const G9_EXIT: u8 = 9;
    pub const ORDER_SHAPE: u8 = 10;
}

/// Order types the owner may allow (bit = 1 << OrderType tag). Trigger orders are never accepted.
pub mod order_type {
    pub const MARKET: u8 = 0;
    pub const LIMIT: u8 = 1;
    pub const TRIGGER_MARKET: u8 = 2;
    pub const TRIGGER_LIMIT: u8 = 3;
    pub const ORACLE: u8 = 4;
}

#[program]
pub mod guard {
    use super::*;

    /// The Velocity user's authority creates the guard with an agent and limits. Afterwards the owner sets the guard
    /// PDA as the user's delegate with Velocity's own update_user_delegate.
    pub fn init_guard(_ctx: Context<InitGuard>, _agent: Pubkey, _limits: Limits) -> Result<()> {
        Ok(())
    }

    /// G7: owner only.
    pub fn set_limits(_ctx: Context<OwnerOnly>, _limits: Limits) -> Result<()> {
        Ok(())
    }

    /// G7: owner only. Pubkey::default() revokes the agent.
    pub fn set_agent(_ctx: Context<OwnerOnly>, _agent: Pubkey) -> Result<()> {
        Ok(())
    }

    /// G7: owner only. While paused, only cancels and exits (G9) go through.
    pub fn set_paused(_ctx: Context<OwnerOnly>, _paused: bool) -> Result<()> {
        Ok(())
    }

    /// The agent's only way to trade. Remaining accounts are Velocity's account maps (oracles, then spot markets,
    /// then perp markets); the guard reads the ones it needs and forwards all of them.
    pub fn place_perp_order<'info>(
        _ctx: Context<'_, '_, 'info, 'info, AgentTrade<'info>>,
        _params: OrderParams,
    ) -> Result<()> {
        Ok(())
    }

    /// G9: cancels are always allowed, even while paused.
    pub fn cancel_order<'info>(
        _ctx: Context<'_, '_, 'info, 'info, AgentTrade<'info>>,
        _order_id: Option<u32>,
    ) -> Result<()> {
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq, InitSpace)]
pub struct MarketLimit {
    /// Velocity perp market index.
    pub market_index: u16,
    /// G4 cap on worst-case exposure in base units (1e9 = 1 SOL). Zero means the row is unused.
    pub max_exposure_base: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq, InitSpace)]
pub struct Limits {
    /// G1: largest base amount per order.
    pub max_order_base: u64,
    /// G2 allowlist and G4 caps.
    pub markets: [MarketLimit; MAX_MARKETS],
    /// G2: bitmask of allowed order types (1 << tag). Only Market, Limit and Oracle may be set.
    pub allowed_order_types: u8,
    /// G3: total order notional per UTC day, in quote units (1e6 = 1 dUSDT).
    pub daily_notional_cap: u64,
    /// G5: worst-case notional over equity, in basis points (10_000 = 1x).
    pub max_leverage_bps: u32,
    /// G6: prices must be within this many basis points of the oracle.
    pub price_band_bps: u32,
    /// G6: the oracle must have been posted within this many slots.
    pub max_oracle_staleness_slots: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Guard {
    pub owner: Pubkey,
    pub velocity_user: Pubkey,
    /// Pubkey::default() when revoked.
    pub agent: Pubkey,
    pub paused: bool,
    pub limits: Limits,
    /// UTC day number (unix / 86400) that day_notional belongs to.
    pub day: i64,
    pub day_notional: u64,
    pub bump: u8,
}

/// Mirror of Velocity's OrderParams (borsh layout from its IDL). Enums are kept as their u8 tags.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct OrderParams {
    pub order_type: u8,
    pub market_type: u8,
    pub direction: u8,
    pub user_order_id: u8,
    pub base_asset_amount: u64,
    pub price: u64,
    pub market_index: u16,
    pub reduce_only: bool,
    pub post_only: u8,
    pub bit_flags: u8,
    pub max_ts: Option<i64>,
    pub trigger_price: Option<u64>,
    pub trigger_condition: u8,
    pub oracle_price_offset: Option<i64>,
    pub auction_duration: Option<u8>,
    pub auction_start_price: Option<i64>,
    pub auction_end_price: Option<i64>,
    pub builder_idx: Option<u8>,
    pub builder_fee_tenth_bps: Option<u16>,
}

/// Emitted for every order the agent sends, accepted or refused (a refused transaction keeps its logs).
#[event]
pub struct OrderChecked {
    pub guard: Pubkey,
    pub accepted: bool,
    /// One of `rule::*`.
    pub rule: u8,
    pub market_index: u16,
    pub direction: u8,
    pub base_asset_amount: u64,
    pub reduce_only: bool,
    /// The measured value for the rule (size, notional, exposure, leverage bps, band bps, slots).
    pub value: i128,
    /// The owner's cap for the rule.
    pub cap: i128,
}

#[derive(Accounts)]
pub struct InitGuard<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: owner, discriminator, size and authority are checked in the handler.
    pub velocity_user: UncheckedAccount<'info>,
    #[account(init, payer = owner, space = 8 + Guard::INIT_SPACE, seeds = [b"guard", velocity_user.key().as_ref()], bump)]
    pub guard: Account<'info, Guard>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ GuardError::NotOwner)]
    pub guard: Account<'info, Guard>,
}

#[derive(Accounts)]
pub struct AgentTrade<'info> {
    pub agent: Signer<'info>,
    #[account(mut, seeds = [b"guard", velocity_user.key().as_ref()], bump = guard.bump, has_one = velocity_user)]
    pub guard: Account<'info, Guard>,
    /// CHECK: Velocity validates it.
    pub velocity_state: UncheckedAccount<'info>,
    /// CHECK: bound to the guard by has_one; owner and discriminator checked in the handler.
    #[account(mut)]
    pub velocity_user: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = velocity::PROGRAM_ID)]
    pub velocity_program: UncheckedAccount<'info>,
}

#[error_code]
pub enum GuardError {
    #[msg("G1: order size exceeds the owner's limit")]
    OrderTooLarge,
    #[msg("G2: market is not on the owner's allowlist")]
    MarketNotAllowed,
    #[msg("G2: order type is not allowed")]
    OrderTypeNotAllowed,
    #[msg("G2: builder fields must be empty")]
    BuilderFieldsRefused,
    #[msg("G3: daily notional cap would be exceeded")]
    DailyNotionalExceeded,
    #[msg("G4: worst-case exposure on this market would exceed the cap")]
    ExposureExceeded,
    #[msg("G5: worst-case leverage would exceed the cap")]
    LeverageExceeded,
    #[msg("G6: price is outside the band around the oracle")]
    PriceOutsideBand,
    #[msg("G6: oracle is stale")]
    StaleOracle,
    #[msg("G7: guard is paused")]
    Paused,
    #[msg("G7: signer is not the owner")]
    NotOwner,
    #[msg("signer is not this guard's agent")]
    NotAgent,
    #[msg("the agent has been revoked")]
    AgentRevoked,
    #[msg("only perp orders are allowed")]
    NotPerp,
    #[msg("order bit flags must be zero")]
    BitFlagsRefused,
    #[msg("trigger orders are not supported")]
    TriggerOrdersRefused,
    #[msg("order size must be greater than zero")]
    ZeroSize,
    #[msg("account is not a Velocity user")]
    NotVelocityUser,
    #[msg("signer is not the Velocity user's authority")]
    NotUserAuthority,
    #[msg("a Velocity market account is invalid")]
    BadMarketAccount,
    #[msg("a needed Velocity market or oracle account is missing")]
    MissingMarketAccount,
    #[msg("the market's oracle source is not supported")]
    UnsupportedOracle,
    #[msg("oracle account is not the market's oracle")]
    WrongOracle,
    #[msg("oracle account is invalid")]
    BadOracleAccount,
    #[msg("account equity is not positive")]
    NonPositiveEquity,
    #[msg("limits are invalid")]
    InvalidLimits,
    #[msg("post-trade check failed")]
    PostTradeCheckFailed,
    #[msg("arithmetic overflow")]
    MathOverflow,
}
