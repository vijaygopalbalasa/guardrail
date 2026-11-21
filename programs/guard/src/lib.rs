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
    pub fn init_guard(ctx: Context<InitGuard>, agent: Pubkey, limits: Limits) -> Result<()> {
        validate_limits(&limits)?;
        let user = velocity::UserView::load(&ctx.accounts.velocity_user.to_account_info())
            .ok_or(GuardError::NotVelocityUser)?;
        require_keys_eq!(user.authority, ctx.accounts.owner.key(), GuardError::NotUserAuthority);
        let g = &mut ctx.accounts.guard;
        g.owner = user.authority;
        g.velocity_user = ctx.accounts.velocity_user.key();
        g.agent = agent;
        g.paused = false;
        g.limits = limits;
        g.day = math::utc_day(Clock::get()?.unix_timestamp);
        g.day_notional = 0;
        g.bump = ctx.bumps.guard;
        msg!("guard created: agent {}", agent);
        Ok(())
    }

    /// G7: owner only.
    pub fn set_limits(ctx: Context<OwnerOnly>, limits: Limits) -> Result<()> {
        validate_limits(&limits)?;
        ctx.accounts.guard.limits = limits;
        msg!("guard: limits updated by the owner");
        Ok(())
    }

    /// G7: owner only. Pubkey::default() revokes the agent.
    pub fn set_agent(ctx: Context<OwnerOnly>, agent: Pubkey) -> Result<()> {
        ctx.accounts.guard.agent = agent;
        msg!("guard: agent set to {}", agent);
        Ok(())
    }

    /// G7: owner only. While paused, only cancels and exits (G9) go through.
    pub fn set_paused(ctx: Context<OwnerOnly>, paused: bool) -> Result<()> {
        ctx.accounts.guard.paused = paused;
        msg!("guard: paused = {}", paused);
        Ok(())
    }

    /// The agent's only way to trade. Remaining accounts are Velocity's account maps (oracles, then spot markets,
    /// then perp markets); the guard reads the ones it needs and forwards all of them.
    pub fn place_perp_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, AgentTrade<'info>>,
        params: OrderParams,
    ) -> Result<()> {
        check_agent(&ctx)?;
        let decision = check_order(&ctx, &params)?;
        let mut data = velocity::IX_PLACE_PERP_ORDER.to_vec();
        params.serialize(&mut data)?;
        forward(&ctx, data)?;
        if let Some(d) = decision {
            post_check(&ctx, &params, &d)?;
            let g = &mut ctx.accounts.guard;
            g.day = d.day;
            g.day_notional = d.day_notional_after;
            emit_checked(g.key(), &params, true, rule::ACCEPTED, d.leverage_bps, g.limits.max_leverage_bps as i128);
        } else {
            emit_checked(ctx.accounts.guard.key(), &params, true, rule::G9_EXIT, 0, 0);
        }
        msg!("guard: order accepted, size {} market {}", params.base_asset_amount, params.market_index);
        Ok(())
    }

    /// G9: cancels are always allowed, even while paused.
    pub fn cancel_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, AgentTrade<'info>>,
        order_id: Option<u32>,
    ) -> Result<()> {
        check_agent(&ctx)?;
        let mut data = velocity::IX_CANCEL_ORDER.to_vec();
        order_id.serialize(&mut data)?;
        forward(&ctx, data)?;
        msg!("guard: cancel {:?} forwarded", order_id);
        Ok(())
    }
}

fn validate_limits(l: &Limits) -> Result<()> {
    let allowed = (1 << order_type::MARKET) | (1 << order_type::LIMIT) | (1 << order_type::ORACLE);
    require!(l.max_order_base > 0, GuardError::InvalidLimits);
    require!(l.allowed_order_types != 0 && l.allowed_order_types & !allowed == 0, GuardError::InvalidLimits);
    require!((1..=10_000).contains(&l.price_band_bps), GuardError::InvalidLimits);
    require!(l.max_leverage_bps >= 1, GuardError::InvalidLimits);
    require!(l.max_oracle_staleness_slots >= 1, GuardError::InvalidLimits);
    for (i, a) in l.markets.iter().enumerate() {
        if a.max_exposure_base == 0 {
            continue;
        }
        for b in l.markets.iter().skip(i + 1) {
            require!(b.max_exposure_base == 0 || b.market_index != a.market_index, GuardError::InvalidLimits);
        }
    }
    Ok(())
}

fn check_agent(ctx: &Context<AgentTrade>) -> Result<()> {
    let g = &ctx.accounts.guard;
    require!(g.agent != Pubkey::default(), GuardError::AgentRevoked);
    require_keys_eq!(ctx.accounts.agent.key(), g.agent, GuardError::NotAgent);
    Ok(())
}

/// G6: the first price field outside the band, as (deviation in bps, field). Velocity reads an order's prices as:
/// `price` absolute; a non-zero `oracle_price_offset` relative to the oracle (it overrides `price` as the limit);
/// auction prices relative for Oracle orders and for Limit orders with an offset, absolute otherwise. A Market order
/// must carry a worst price.
fn band_breach(p: &OrderParams, oracle: i64, band: u32) -> Option<(i128, &'static str)> {
    let dev = |x: i128| (x - oracle as i128).abs() * math::BPS / oracle as i128;
    let off = |x: i128| x.abs() * math::BPS / oracle as i128;
    if p.order_type == order_type::MARKET && p.price == 0 {
        return Some((math::BPS, "market order without a worst price"));
    }
    if p.price != 0 && !math::within_band(p.price as i128, oracle, band) {
        return Some((dev(p.price as i128), "price"));
    }
    let offset = p.oracle_price_offset.unwrap_or(0);
    if offset != 0 && !math::offset_within_band(offset as i128, oracle, band) {
        return Some((off(offset as i128), "oracle_price_offset"));
    }
    let relative = p.order_type == order_type::ORACLE || (p.order_type == order_type::LIMIT && offset != 0);
    for a in [p.auction_start_price, p.auction_end_price].into_iter().flatten() {
        let ok = if relative { math::offset_within_band(a as i128, oracle, band) } else { math::within_band(a as i128, oracle, band) };
        if !ok {
            return Some((if relative { off(a as i128) } else { dev(a as i128) }, "auction price"));
        }
    }
    None
}

fn emit_checked(guard: Pubkey, p: &OrderParams, accepted: bool, rule_code: u8, value: i128, cap: i128) {
    emit!(OrderChecked {
        guard,
        accepted,
        rule: rule_code,
        market_index: p.market_index,
        direction: p.direction,
        base_asset_amount: p.base_asset_amount,
        reduce_only: p.reduce_only,
        value,
        cap,
    });
}

/// Logs the reason, emits the refusal event (kept in the failed transaction's logs) and returns the error.
fn refuse(guard: Pubkey, p: &OrderParams, rule_code: u8, value: i128, cap: i128, e: GuardError) -> Result<Option<Decision>> {
    msg!("guard REFUSED (rule {}): {} (value {}, cap {})", rule_code, e, value, cap);
    emit_checked(guard, p, false, rule_code, value, cap);
    Err(e.into())
}

/// What the pre-check computed, re-asserted after the CPI.
struct Decision {
    day: i64,
    day_notional_after: u64,
    exposure_cap: u64,
    exposure_after: i128,
    leverage_bps: i128,
    prices: Vec<(u16, i64)>,
}

fn find<'a, 'info>(ra: &'a [AccountInfo<'info>], key: &Pubkey) -> Option<&'a AccountInfo<'info>> {
    ra.iter().find(|a| a.key == key)
}

/// The perp market's own oracle price (1e6) and its age in slots, from the remaining accounts.
fn market_price(ra: &[AccountInfo], market_index: u16, slot: u64) -> std::result::Result<(i64, u64), GuardError> {
    let pm_acc = find(ra, &velocity::perp_market_address(market_index)).ok_or(GuardError::MissingMarketAccount)?;
    let pm = velocity::load_perp_market(pm_acc, market_index).ok_or(GuardError::BadMarketAccount)?;
    if pm.oracle_source != velocity::ORACLE_SOURCE_PYTH_LAZER {
        return Err(GuardError::UnsupportedOracle);
    }
    let o_acc = find(ra, &pm.oracle).ok_or(GuardError::MissingMarketAccount)?;
    let o = velocity::load_oracle(o_acc).ok_or(GuardError::BadOracleAccount)?;
    let price = math::price_to_1e6(o.price, o.exponent).ok_or(GuardError::BadOracleAccount)?;
    Ok((price, slot.saturating_sub(o.posted_slot)))
}

/// Collateral (spot market 0, the quote asset) in quote units. Deposits in other spot markets are not counted
/// (that understates equity, the safe side); a borrow in another spot market is refused, because ignoring it would
/// overstate equity.
fn collateral(ra: &[AccountInfo], user: &velocity::UserView) -> std::result::Result<i128, GuardError> {
    if user.spot.iter().any(|s| s.market_index != 0 && s.scaled_balance > 0 && s.balance_type == 1) {
        return Err(GuardError::OtherSpotBorrow);
    }
    let sm_acc = find(ra, &velocity::spot_market_address(0)).ok_or(GuardError::MissingMarketAccount)?;
    let sm = velocity::load_spot_market(sm_acc, 0).ok_or(GuardError::BadMarketAccount)?;
    let mut total: i128 = 0;
    for s in user.spot.iter().filter(|s| s.market_index == 0 && s.scaled_balance > 0) {
        if s.balance_type == 0 {
            total += math::token_amount(s.scaled_balance, sm.cumulative_deposit_interest, sm.decimals).ok_or(GuardError::MathOverflow)?;
        } else {
            total -= math::token_amount(s.scaled_balance, sm.cumulative_borrow_interest, sm.decimals).ok_or(GuardError::MathOverflow)?;
        }
    }
    Ok(total)
}

/// Worst-case notional over every market with activity (plus this order) and equity (collateral + uPnL).
fn account_leverage(
    ra: &[AccountInfo],
    user: &velocity::UserView,
    prices: &[(u16, i64)],
    order: Option<(&OrderParams,)>,
) -> std::result::Result<(i128, i128), GuardError> {
    let mut markets = user.active_markets();
    if let Some((p,)) = order {
        if !markets.contains(&p.market_index) {
            markets.push(p.market_index);
        }
    }
    let mut notional: i128 = 0;
    let mut upnl: i128 = 0;
    for m in markets {
        let price = prices.iter().find(|(i, _)| *i == m).map(|(_, p)| *p).ok_or(GuardError::MissingMarketAccount)?;
        let t = user.perp_totals(m);
        let wc = match order {
            Some((p,)) if p.market_index == m => math::worst_case_after(t.base, t.open_bids, t.open_asks, p.direction, p.base_asset_amount),
            _ => math::worst_case_base(t.base, t.open_bids, t.open_asks),
        };
        notional += math::notional(wc, price);
        upnl += math::notional(t.base as i128, price) + t.quote as i128;
    }
    Ok((notional, collateral(ra, user)? + upnl))
}

/// Pre-CPI checks. Ok(None) means the order is a G9 exit and skips the limits; Ok(Some) carries what to re-check.
fn check_order(ctx: &Context<AgentTrade>, p: &OrderParams) -> Result<Option<Decision>> {
    let g = &ctx.accounts.guard;
    let gk = g.key();
    let l = &g.limits;
    let ra = ctx.remaining_accounts;
    let clock = Clock::get()?;

    // Order shape, always enforced (exits included).
    if p.market_type != 1 {
        return refuse(gk, p, rule::ORDER_SHAPE, p.market_type as i128, 1, GuardError::NotPerp);
    }
    if p.base_asset_amount == 0 {
        return refuse(gk, p, rule::ORDER_SHAPE, 0, 0, GuardError::ZeroSize);
    }
    if p.bit_flags != 0 {
        return refuse(gk, p, rule::ORDER_SHAPE, p.bit_flags as i128, 0, GuardError::BitFlagsRefused);
    }
    if p.order_type == order_type::TRIGGER_MARKET || p.order_type == order_type::TRIGGER_LIMIT || p.trigger_price.is_some() {
        return refuse(gk, p, rule::ORDER_SHAPE, p.order_type as i128, 0, GuardError::TriggerOrdersRefused);
    }
    if p.builder_idx.is_some() || p.builder_fee_tenth_bps.is_some() {
        return refuse(gk, p, rule::G2_ALLOWLIST, 1, 0, GuardError::BuilderFieldsRefused);
    }

    let user = velocity::UserView::load(&ctx.accounts.velocity_user.to_account_info()).ok_or(GuardError::NotVelocityUser)?;
    let pos = user.perp_totals(p.market_index);

    // G9: a true exit skips the limits and the pause, but its price must stay in the band (from the oracle's last
    // price, stale or not) so an exit cannot hand the position's value to a partner far from the market.
    if math::is_exit(p.reduce_only, p.direction, p.base_asset_amount, pos.base) {
        let oracle = match market_price(ra, p.market_index, clock.slot) {
            Ok((price, _age)) => price,
            Err(e) => return refuse(gk, p, rule::ORDER_SHAPE, p.market_index as i128, 0, e),
        };
        if let Some((bps, _)) = band_breach(p, oracle, l.price_band_bps) {
            return refuse(gk, p, rule::G6_PRICE_BAND, bps, l.price_band_bps as i128, GuardError::PriceOutsideBand);
        }
        msg!("guard: G9 exit (reduce-only, opposite to a {} position, size {})", pos.base, p.base_asset_amount);
        return Ok(None);
    }

    // G7
    if g.paused {
        return refuse(gk, p, rule::G7_PAUSED, 1, 0, GuardError::Paused);
    }
    // G2
    let row = match l.markets.iter().find(|m| m.max_exposure_base > 0 && m.market_index == p.market_index) {
        Some(r) => *r,
        None => return refuse(gk, p, rule::G2_ALLOWLIST, p.market_index as i128, 0, GuardError::MarketNotAllowed),
    };
    if p.order_type > 7 || l.allowed_order_types & (1u8 << p.order_type) == 0 {
        return refuse(gk, p, rule::G2_ALLOWLIST, p.order_type as i128, l.allowed_order_types as i128, GuardError::OrderTypeNotAllowed);
    }
    // G1
    if p.base_asset_amount > l.max_order_base {
        return refuse(gk, p, rule::G1_ORDER_SIZE, p.base_asset_amount as i128, l.max_order_base as i128, GuardError::OrderTooLarge);
    }

    // Prices: the order's market and every market with an open position or order, each from its own oracle.
    let mut markets = user.active_markets();
    if !markets.contains(&p.market_index) {
        markets.push(p.market_index);
    }
    let mut prices: Vec<(u16, i64)> = vec![];
    for m in markets {
        match market_price(ra, m, clock.slot) {
            Ok((price, age)) => {
                // G6 stale oracle
                if age > l.max_oracle_staleness_slots {
                    return refuse(gk, p, rule::G6_PRICE_BAND, age as i128, l.max_oracle_staleness_slots as i128, GuardError::StaleOracle);
                }
                prices.push((m, price));
            }
            Err(e) => return refuse(gk, p, rule::ORDER_SHAPE, m as i128, 0, e),
        }
    }
    let oracle = prices.iter().find(|(i, _)| *i == p.market_index).unwrap().1;

    // G6 price band on every price field.
    if let Some((bps, _)) = band_breach(p, oracle, l.price_band_bps) {
        return refuse(gk, p, rule::G6_PRICE_BAND, bps, l.price_band_bps as i128, GuardError::PriceOutsideBand);
    }

    // G3 daily notional at the oracle price.
    let day = math::utc_day(clock.unix_timestamp);
    let used = if g.day == day { g.day_notional as i128 } else { 0 };
    let after = used + math::notional(p.base_asset_amount as i128, oracle);
    if after > l.daily_notional_cap as i128 {
        return refuse(gk, p, rule::G3_DAILY_NOTIONAL, after, l.daily_notional_cap as i128, GuardError::DailyNotionalExceeded);
    }

    // G4 worst-case exposure on this market, this order included.
    let exposure = math::worst_case_after(pos.base, pos.open_bids, pos.open_asks, p.direction, p.base_asset_amount);
    if exposure > row.max_exposure_base as i128 {
        return refuse(gk, p, rule::G4_EXPOSURE, exposure, row.max_exposure_base as i128, GuardError::ExposureExceeded);
    }

    // G5 worst-case leverage over the whole account.
    let (notional, equity) = match account_leverage(ra, &user, &prices, Some((p,))) {
        Ok(v) => v,
        Err(e) => return refuse(gk, p, rule::G5_LEVERAGE, 0, 0, e),
    };
    let lev = match math::leverage_bps(notional, equity) {
        Some(v) => v,
        None => return refuse(gk, p, rule::G5_LEVERAGE, equity, 0, GuardError::NonPositiveEquity),
    };
    if lev > l.max_leverage_bps as i128 {
        return refuse(gk, p, rule::G5_LEVERAGE, lev, l.max_leverage_bps as i128, GuardError::LeverageExceeded);
    }

    Ok(Some(Decision {
        day,
        day_notional_after: u64::try_from(after).map_err(|_| GuardError::MathOverflow)?,
        exposure_cap: row.max_exposure_base,
        exposure_after: exposure,
        leverage_bps: lev,
        prices,
    }))
}

/// After the CPI: re-read the Velocity account and assert the same caps hold on what Velocity actually recorded.
fn post_check(ctx: &Context<AgentTrade>, p: &OrderParams, d: &Decision) -> Result<()> {
    let user = velocity::UserView::load(&ctx.accounts.velocity_user.to_account_info()).ok_or(GuardError::NotVelocityUser)?;
    let t = user.perp_totals(p.market_index);
    let exposure = math::worst_case_base(t.base, t.open_bids, t.open_asks);
    let (notional, equity) = account_leverage(ctx.remaining_accounts, &user, &d.prices, None).map_err(|e| -> Error { e.into() })?;
    let lev = math::leverage_bps(notional, equity).ok_or(GuardError::PostTradeCheckFailed)?;
    let l = &ctx.accounts.guard.limits;
    if exposure > d.exposure_cap as i128 || lev > l.max_leverage_bps as i128 {
        msg!(
            "guard POST-TRADE CHECK FAILED: exposure {} (pre {}) cap {}, leverage {} cap {}",
            exposure, d.exposure_after, d.exposure_cap, lev, l.max_leverage_bps
        );
        return err!(GuardError::PostTradeCheckFailed);
    }
    Ok(())
}

/// CPI into Velocity with [state, user (mut), guard PDA (signer)] plus all remaining accounts.
fn forward<'info>(ctx: &Context<'_, '_, 'info, 'info, AgentTrade<'info>>, data: Vec<u8>) -> Result<()> {
    use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke_signed};
    let g = &ctx.accounts.guard;
    let mut metas = vec![
        AccountMeta::new_readonly(ctx.accounts.velocity_state.key(), false),
        AccountMeta::new(ctx.accounts.velocity_user.key(), false),
        AccountMeta::new_readonly(g.key(), true),
    ];
    let mut infos = vec![
        ctx.accounts.velocity_state.to_account_info(),
        ctx.accounts.velocity_user.to_account_info(),
        g.to_account_info(),
    ];
    for a in ctx.remaining_accounts.iter() {
        metas.push(if a.is_writable { AccountMeta::new(a.key(), false) } else { AccountMeta::new_readonly(a.key(), false) });
        infos.push(a.clone());
    }
    infos.push(ctx.accounts.velocity_program.to_account_info());
    let ix = Instruction { program_id: velocity::PROGRAM_ID, accounts: metas, data };
    let user_key = ctx.accounts.velocity_user.key();
    let seeds: &[&[u8]] = &[b"guard", user_key.as_ref(), &[g.bump]];
    invoke_signed(&ix, &infos, &[seeds])?;
    Ok(())
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
    #[msg("a borrow in a spot market other than the quote market is not supported")]
    OtherSpotBorrow,
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
