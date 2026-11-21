//! Guardrail: limits your AI trading agent cannot break.
//!
//! The guard PDA is the delegate of a user's Velocity perps account. The agent key can trade only by calling this
//! program; every order is checked against limits the owner froze on chain, and an order that breaks one is refused
//! with its reason. The guard exposes only place_perp_order and cancel_order to the agent; there is no withdraw.

// Anchor 0.31's #[program] macro calls the deprecated AccountInfo::realloc in generated code.
#![allow(deprecated)]

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
    pub const G10_DAILY_LOSS: u8 = 10;
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

    /// G10, owner only: the most equity (quote units) the account may lose in one UTC day before risk-increasing
    /// orders are refused. 0 turns the brake off.
    pub fn set_daily_loss(ctx: Context<OwnerOnly>, max_daily_loss: u64) -> Result<()> {
        ctx.accounts.guard.max_daily_loss = max_daily_loss;
        msg!("guard: daily loss cap set to {} by the owner", max_daily_loss);
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
        mut ctx: Context<'_, '_, 'info, 'info, AgentTrade<'info>>,
        params: OrderParams,
    ) -> Result<()> {
        let before: Vec<u32> = velocity::UserView::load(&ctx.accounts.velocity_user.to_account_info())
            .ok_or(GuardError::NotVelocityUser)?
            .orders
            .iter()
            .map(|o| o.order_id)
            .collect();
        // Forget placed ids that are no longer open (filled, cancelled or expired). A live id is never overwritten.
        prune_placed(&mut ctx.accounts.guard, &before);
        take_day_baseline(&mut ctx)?;
        let mut baseline: Option<Baseline> = None;
        let mut outcome = check_order(&ctx, &params, &mut baseline)?;
        if let Some(b) = baseline {
            // The day's first risk-increasing check stores the baseline, refused or not, so it never moves within a day.
            let g = &mut ctx.accounts.guard;
            g.loss_day = b.day;
            g.baseline_equity = b.equity;
            g.baseline_flows = b.flows;
        }
        if !matches!(outcome, Outcome::Refuse { .. }) && !ctx.accounts.guard.placed_order_ids.contains(&0) {
            let n = ctx.accounts.guard.placed_order_ids.len() as i128;
            outcome = Outcome::Refuse { rule: rule::G2_ALLOWLIST, value: n, cap: n, reason: GuardError::TooManyOpenOrders };
        }
        if let Outcome::Refuse { rule: r, value, cap, reason } = outcome {
            // A limit refusal is a recorded success: Velocity is not called, the Guard counts it, the event says why.
            let slot = Clock::get()?.slot;
            let g = &mut ctx.accounts.guard;
            match r {
                rule::G1_ORDER_SIZE => g.refused_g1 += 1,
                rule::G2_ALLOWLIST => g.refused_g2 += 1,
                rule::G3_DAILY_NOTIONAL => g.refused_g3 += 1,
                rule::G4_EXPOSURE => g.refused_g4 += 1,
                rule::G5_LEVERAGE => g.refused_g5 += 1,
                rule::G6_PRICE_BAND => g.refused_g6 += 1,
                rule::G7_PAUSED => g.refused_g7 += 1,
                rule::G10_DAILY_LOSS => g.refused_g10 += 1,
                _ => {}
            }
            let lr = LastRefusal { rule: r, reason: u32::from(reason), value, cap, slot };
            g.last_refusal = lr;
            if r == rule::G10_DAILY_LOSS {
                g.last_refusal_g10 = lr;
            } else {
                g.last_refusal_by_rule[(r as usize).min(7)] = lr;
            }
            msg!("guard REFUSED (rule {}): {} (value {}, cap {})", r, reason, value, cap);
            emit_checked(g.key(), &params, false, r, value, cap, u32::from(reason));
            return Ok(());
        }
        let mut data = velocity::IX_PLACE_PERP_ORDER.to_vec();
        params.serialize(&mut data)?;
        forward(&ctx, data)?;
        // Re-check what Velocity actually stored for the new order (it can write its own auction prices), then record
        // its id so the agent can later cancel it (and only it).
        let placed = stored_order_check(&ctx, &params, &outcome, &before)?;
        if placed.is_empty() {
            // Velocity skipped the order (for example a past max_ts): nothing to count, charge or remember.
            msg!("guard: Velocity stored no order for this call");
            return err!(GuardError::OrderNotStored);
        }
        match outcome {
            Outcome::Accept(d) => {
                // A cap exceeded after the CPI would be a guard bug, not a refusal: fail the transaction.
                post_check(&ctx, &params, &d)?;
                let g = &mut ctx.accounts.guard;
                g.day = d.day;
                g.day_notional = d.day_notional_after;
                g.accepted_count += 1;
                record_placed(g, &placed)?;
                emit_checked(g.key(), &params, true, rule::ACCEPTED, d.leverage_bps, g.limits.max_leverage_bps as i128, 0);
            }
            _ => {
                let g = &mut ctx.accounts.guard;
                g.accepted_count += 1;
                record_placed(g, &placed)?;
                emit_checked(g.key(), &params, true, rule::G9_EXIT, 0, 0, 0);
            }
        }
        msg!("guard: order accepted, size {} market {}", params.base_asset_amount, params.market_index);
        Ok(())
    }

    /// G9: the agent may always cancel an order the guard placed, even while paused. It may not cancel the owner's
    /// own orders or cancel everything (None); such a request is a recorded refusal.
    pub fn cancel_order<'info>(
        mut ctx: Context<'_, '_, 'info, 'info, AgentTrade<'info>>,
        order_id: Option<u32>,
    ) -> Result<()> {
        take_day_baseline(&mut ctx)?;
        let g = &ctx.accounts.guard;
        let allowed = match order_id {
            Some(id) if id != 0 => g.placed_order_ids.contains(&id),
            _ => false,
        };
        if !allowed {
            let g = &mut ctx.accounts.guard;
            g.refused_cancels += 1;
            msg!("guard REFUSED cancel {:?}: only orders the guard placed can be cancelled by id", order_id);
            emit!(CancelChecked { guard: g.key(), order_id: order_id.unwrap_or(0), accepted: false, reason: u32::from(GuardError::CancelNotAllowed) });
            return Ok(());
        }
        let id = order_id.unwrap();
        let mut data = velocity::IX_CANCEL_ORDER.to_vec();
        order_id.serialize(&mut data)?;
        forward(&ctx, data)?;
        let g = &mut ctx.accounts.guard;
        if let Some(slot) = g.placed_order_ids.iter_mut().find(|x| **x == id) {
            *slot = 0;
        }
        g.cancel_count += 1;
        emit!(CancelChecked { guard: g.key(), order_id: id, accepted: true, reason: 0 });
        msg!("guard: cancel {} forwarded", id);
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
    require!(l.exit_max_staleness_slots >= l.max_oracle_staleness_slots, GuardError::InvalidLimits);
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
    let off0 = p.oracle_price_offset.unwrap_or(0);
    if p.order_type == order_type::ORACLE && off0 == 0 {
        // Velocity forbids a price on Oracle orders, so the offset is the only limit; without it the order fills at
        // any price after the auction (audit F1).
        return Some((math::BPS, "oracle order without an offset"));
    }
    if p.order_type == order_type::LIMIT && p.price == 0 && off0 == 0 {
        return Some((math::BPS, "limit order without a price"));
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

/// G9 with a very stale oracle: the first price field on the owner-unfavourable side of the last oracle price.
/// A sell must be at or above it, a buy at or below it; offsets and relative auction prices must not cross zero
/// the wrong way; an exit must carry a price (a Market order without one, or a Limit with neither price nor offset,
/// is refused).
fn unfavourable_for_stale_exit(p: &OrderParams, oracle: i64) -> Option<&'static str> {
    let sell = p.direction == 1;
    let ok_abs = |x: i128| if sell { x >= oracle as i128 } else { x <= oracle as i128 };
    let ok_rel = |x: i128| if sell { x >= 0 } else { x <= 0 };
    let offset = p.oracle_price_offset.unwrap_or(0);
    if p.price == 0 && offset == 0 {
        return Some("missing price");
    }
    if p.price != 0 && !ok_abs(p.price as i128) {
        return Some("price");
    }
    if offset != 0 && !ok_rel(offset as i128) {
        return Some("oracle_price_offset");
    }
    let relative = p.order_type == order_type::ORACLE || (p.order_type == order_type::LIMIT && offset != 0);
    for a in [p.auction_start_price, p.auction_end_price].into_iter().flatten() {
        let ok = if relative { ok_rel(a as i128) } else { ok_abs(a as i128) };
        if !ok {
            return Some("auction price");
        }
    }
    None
}

/// The absolute prices an order stored on Velocity can execute at: its limit price or oracle offset, and its
/// auction prices (relative for Oracle orders and offset Limit orders). None if the order has no worst price.
fn stored_prices(o: &velocity::OrderSlot, oracle: i64) -> Option<Vec<i128>> {
    let orc = oracle as i128;
    let relative = o.order_type == order_type::ORACLE || (o.order_type == order_type::LIMIT && o.oracle_price_offset != 0);
    let mut v = vec![];
    if o.oracle_price_offset != 0 {
        v.push(orc + o.oracle_price_offset as i128);
    } else if o.order_type == order_type::ORACLE || o.price == 0 {
        return None;
    } else {
        v.push(o.price as i128);
    }
    if o.auction_duration > 0 || o.auction_start != 0 || o.auction_end != 0 {
        for a in [o.auction_start, o.auction_end] {
            v.push(if relative { orc + a as i128 } else { a as i128 });
        }
    }
    Some(v)
}

/// The first stored price on the owner-unfavourable side of `limit_bps` around the oracle (a buy above the band, a
/// sell below it). With `limit_bps` 0 the bound is the oracle price itself.
pub fn stored_breach(o: &velocity::OrderSlot, oracle: i64, limit_bps: u32) -> Option<i128> {
    let prices = match stored_prices(o, oracle) {
        Some(p) => p,
        None => return Some(0),
    };
    let edge = oracle as i128 * limit_bps as i128 / math::BPS;
    prices.into_iter().find(|&x| if o.direction == 0 { x > oracle as i128 + edge } else { x < oracle as i128 - edge })
}

/// With a lifetime cap set, a stored order must expire after now and within the cap (max_ts 0 never expires).
pub fn stored_lifetime_breach(o: &velocity::OrderSlot, now: i64, cap_secs: u64) -> bool {
    cap_secs > 0 && (o.max_ts <= now || o.max_ts as i128 - now as i128 > cap_secs as i128)
}

/// After the CPI: the orders Velocity stored for this call (ids not present before) must have a worst price inside
/// the band on the owner-unfavourable side; for a very stale exit, on the owner-favourable side of the last price.
fn stored_order_check(ctx: &Context<AgentTrade>, p: &OrderParams, outcome: &Outcome, before: &[u32]) -> Result<Vec<u32>> {
    let user = velocity::UserView::load(&ctx.accounts.velocity_user.to_account_info()).ok_or(GuardError::NotVelocityUser)?;
    let l = &ctx.accounts.guard.limits;
    let (oracle, age) = market_price(ctx.remaining_accounts, p.market_index, Clock::get()?.slot)?;
    let limit = match outcome {
        Outcome::Exit if age > l.exit_max_staleness_slots => 0,
        _ => l.price_band_bps,
    };
    let now = Clock::get()?.unix_timestamp;
    let mut placed = vec![];
    for o in user.orders.iter().filter(|o| !before.contains(&o.order_id)) {
        if let Some(x) = stored_breach(o, oracle, limit) {
            msg!("guard POST-TRADE CHECK FAILED: stored order {} can execute at {} (oracle {}, limit {} bps)", o.order_id, x, oracle, limit);
            return err!(GuardError::PostTradeCheckFailed);
        }
        if !matches!(outcome, Outcome::Exit) && stored_lifetime_breach(o, now, l.max_order_lifetime_secs) {
            msg!("guard POST-TRADE CHECK FAILED: stored order {} has max_ts {} (now {}, lifetime cap {} s)", o.order_id, o.max_ts, now, l.max_order_lifetime_secs);
            return err!(GuardError::PostTradeCheckFailed);
        }
        placed.push(o.order_id);
    }
    Ok(placed)
}

/// Clears remembered ids that are no longer among the Velocity User's open orders.
fn prune_placed(g: &mut Guard, open: &[u32]) {
    for id in g.placed_order_ids.iter_mut() {
        if *id != 0 && !open.contains(id) {
            *id = 0;
        }
    }
}

/// Remembers order ids the guard placed, each in a free slot (32 slots, the size of Velocity's order book per user).
/// A live id is never evicted: with no free slot the call fails (the pre-check already refuses that case).
fn record_placed(g: &mut Guard, ids: &[u32]) -> Result<()> {
    for id in ids {
        match g.placed_order_ids.iter_mut().find(|x| **x == 0) {
            Some(slot) => *slot = *id,
            None => return err!(GuardError::TooManyOpenOrders),
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_checked(guard: Pubkey, p: &OrderParams, accepted: bool, rule_code: u8, value: i128, cap: i128, reason: u32) {
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
        reason,
    });
}

/// The pre-check's verdict. Real errors (wrong agent, bad accounts, stale oracle) are Err instead.
enum Outcome {
    Accept(Decision),
    /// A G9 exit: skips G1 to G5, the pause and staleness; already checked against the band.
    Exit,
    Refuse { rule: u8, value: i128, cap: i128, reason: GuardError },
}

fn refuse(rule_code: u8, value: i128, cap: i128, reason: GuardError) -> Result<Outcome> {
    Ok(Outcome::Refuse { rule: rule_code, value, cap, reason })
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

/// Collateral (spot market 0, the quote asset) in quote units. Fails closed: any balance in another spot market
/// (deposit or borrow) or a negative quote balance refuses risk-increasing orders, since the guard values only the
/// quote deposit.
fn collateral(ra: &[AccountInfo], user: &velocity::UserView) -> std::result::Result<i128, GuardError> {
    if user.spot.iter().any(|s| s.scaled_balance != 0 && (s.market_index != 0 || s.balance_type == 1)) {
        return Err(GuardError::OtherSpotBalance);
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

/// Pre-CPI checks.
/// G10's baseline for a UTC day: equity and Velocity's net deposits at the day's first risk-increasing check.
#[derive(Clone, Copy)]
struct Baseline {
    day: i64,
    equity: i64,
    flows: i64,
}

/// G10: the guard's first call of a UTC day (an order, an exit or a cancel) takes the day's baseline when every price
/// it needs is present and fresh. It never fails the call; if it cannot price the account, the next call tries again.
fn take_day_baseline(ctx: &mut Context<AgentTrade>) -> Result<()> {
    let clock = Clock::get()?;
    let today = math::utc_day(clock.unix_timestamp);
    let g = &ctx.accounts.guard;
    if g.max_daily_loss == 0 || (g.loss_day == today && g.baseline_equity != 0) {
        return Ok(());
    }
    let Some(user) = velocity::UserView::load(&ctx.accounts.velocity_user.to_account_info()) else { return Ok(()) };
    let mut prices = vec![];
    for m in user.active_markets() {
        match market_price(ctx.remaining_accounts, m, clock.slot) {
            Ok((p, age)) if age <= g.limits.max_oracle_staleness_slots => prices.push((m, p)),
            _ => return Ok(()),
        }
    }
    let Ok((_, equity)) = account_leverage(ctx.remaining_accounts, &user, &prices, None) else { return Ok(()) };
    let (Ok(eq), Ok(flows)) = (i64::try_from(equity), i64::try_from(net_flows(&user))) else { return Ok(()) };
    let g = &mut ctx.accounts.guard;
    g.loss_day = today;
    g.baseline_equity = eq;
    g.baseline_flows = flows;
    Ok(())
}

fn net_flows(user: &velocity::UserView) -> i128 {
    user.total_deposits as i128 - user.total_withdraws as i128
}

/// G10: today's loss in quote units, with deposits and withdrawals since the baseline taken out of it.
pub fn daily_loss(baseline_equity: i128, baseline_flows: i128, equity: i128, flows: i128) -> i128 {
    baseline_equity + (flows - baseline_flows) - equity
}

fn check_order(ctx: &Context<AgentTrade>, p: &OrderParams, baseline: &mut Option<Baseline>) -> Result<Outcome> {
    let g = &ctx.accounts.guard;
    let l = &g.limits;
    let ra = ctx.remaining_accounts;
    let clock = Clock::get()?;

    // Order shape, always enforced (exits included).
    if p.market_type != 1 {
        return refuse(rule::G2_ALLOWLIST, p.market_type as i128, 1, GuardError::NotPerp);
    }
    if p.base_asset_amount == 0 {
        return refuse(rule::G2_ALLOWLIST, 0, 0, GuardError::ZeroSize);
    }
    if p.bit_flags != 0 {
        return refuse(rule::G2_ALLOWLIST, p.bit_flags as i128, 0, GuardError::BitFlagsRefused);
    }
    if p.order_type == order_type::TRIGGER_MARKET || p.order_type == order_type::TRIGGER_LIMIT || p.trigger_price.is_some() {
        return refuse(rule::G2_ALLOWLIST, p.order_type as i128, 0, GuardError::TriggerOrdersRefused);
    }
    if p.builder_idx.is_some() || p.builder_fee_tenth_bps.is_some() {
        return refuse(rule::G2_ALLOWLIST, 1, 0, GuardError::BuilderFieldsRefused);
    }

    let user = velocity::UserView::load(&ctx.accounts.velocity_user.to_account_info()).ok_or(GuardError::NotVelocityUser)?;
    let pos = user.perp_totals(p.market_index);

    // G9: a true exit (reduce-only, opposite to the position, and with the exits already resting no larger than it)
    // skips G1, G3, G4, G5 and the pause, and is never blocked by staleness. It keeps G2, and its price must stay
    // inside the band (or, with a very stale oracle, on the owner-favourable side of the last price).
    let resting = user.resting_reduce_only(p.market_index, p.direction);
    if math::is_exit(p.reduce_only, p.direction, p.base_asset_amount, pos.base, resting) {
        // Exits keep G2 (audit F2): only allowed markets and order types.
        if !l.markets.iter().any(|m| m.max_exposure_base > 0 && m.market_index == p.market_index) {
            return refuse(rule::G2_ALLOWLIST, p.market_index as i128, 0, GuardError::MarketNotAllowed);
        }
        if p.order_type > 7 || l.allowed_order_types & (1u8 << p.order_type) == 0 {
            return refuse(rule::G2_ALLOWLIST, p.order_type as i128, l.allowed_order_types as i128, GuardError::OrderTypeNotAllowed);
        }
        let (oracle, age) = market_price(ra, p.market_index, clock.slot)?;
        if age > l.exit_max_staleness_slots {
            // Very stale: the band would be centred on an old price, so only owner-favourable prices are allowed.
            // At worst such an exit does not fill; it can never give value away.
            if let Some(what) = unfavourable_for_stale_exit(p, oracle) {
                msg!("guard: stale exit ({} slots) refused: {} is on the unfavourable side of {}", age, what, oracle);
                return refuse(rule::G6_PRICE_BAND, age as i128, l.exit_max_staleness_slots as i128, GuardError::StaleExitUnfavourable);
            }
        } else if let Some((bps, _)) = band_breach(p, oracle, l.price_band_bps) {
            return refuse(rule::G6_PRICE_BAND, bps, l.price_band_bps as i128, GuardError::PriceOutsideBand);
        }
        msg!("guard: G9 exit (reduce-only, opposite to a {} position, size {})", pos.base, p.base_asset_amount);
        return Ok(Outcome::Exit);
    }

    // G7
    if g.paused {
        return refuse(rule::G7_PAUSED, 1, 0, GuardError::Paused);
    }
    // G2
    let row = match l.markets.iter().find(|m| m.max_exposure_base > 0 && m.market_index == p.market_index) {
        Some(r) => *r,
        None => return refuse(rule::G2_ALLOWLIST, p.market_index as i128, 0, GuardError::MarketNotAllowed),
    };
    if p.order_type > 7 || l.allowed_order_types & (1u8 << p.order_type) == 0 {
        return refuse(rule::G2_ALLOWLIST, p.order_type as i128, l.allowed_order_types as i128, GuardError::OrderTypeNotAllowed);
    }
    // G1
    if p.base_asset_amount > l.max_order_base {
        return refuse(rule::G1_ORDER_SIZE, p.base_asset_amount as i128, l.max_order_base as i128, GuardError::OrderTooLarge);
    }
    // Order lifetime: a resting order must expire within the owner's bound, so a stale price cannot rest forever.
    if l.max_order_lifetime_secs > 0 {
        // Velocity stores max_ts 0 as "never expires" and skips a past one, so anything not in the future is unbounded.
        let now = clock.unix_timestamp as i128;
        let life = match p.max_ts {
            Some(t) if t as i128 > now => t as i128 - now,
            _ => i128::MAX,
        };
        if life > l.max_order_lifetime_secs as i128 {
            return refuse(rule::G2_ALLOWLIST, life.min(i64::MAX as i128), l.max_order_lifetime_secs as i128, GuardError::OrderLifetimeTooLong);
        }
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
                // G6 stale oracle: a real error, not a refusal.
                if age > l.max_oracle_staleness_slots {
                    msg!("guard: oracle for market {} is {} slots old (max {})", m, age, l.max_oracle_staleness_slots);
                    return err!(GuardError::StaleOracle);
                }
                prices.push((m, price));
            }
            Err(e) => return Err(e.into()),
        }
    }
    let oracle = prices.iter().find(|(i, _)| *i == p.market_index).unwrap().1;

    // G10 daily loss: the day's first risk-increasing check stores a baseline; past the cap, only exits pass.
    if g.max_daily_loss > 0 {
        let equity = match account_leverage(ra, &user, &prices, None) {
            Ok((_, e)) => e,
            Err(GuardError::OtherSpotBalance) => return refuse(rule::G5_LEVERAGE, 0, 0, GuardError::OtherSpotBalance),
            Err(e) => return Err(e.into()),
        };
        let flows = net_flows(&user);
        let today = math::utc_day(clock.unix_timestamp);
        let (b_eq, b_flows) = if g.loss_day == today && g.baseline_equity != 0 {
            (g.baseline_equity as i128, g.baseline_flows as i128)
        } else {
            let b = Baseline {
                day: today,
                equity: i64::try_from(equity).map_err(|_| GuardError::MathOverflow)?,
                flows: i64::try_from(flows).map_err(|_| GuardError::MathOverflow)?,
            };
            *baseline = Some(b);
            (equity, flows)
        };
        let loss = daily_loss(b_eq, b_flows, equity, flows);
        if loss > g.max_daily_loss as i128 {
            return refuse(rule::G10_DAILY_LOSS, loss, g.max_daily_loss as i128, GuardError::DailyLossExceeded);
        }
    }

    // G6 price band on every price field.
    if let Some((bps, _)) = band_breach(p, oracle, l.price_band_bps) {
        return refuse(rule::G6_PRICE_BAND, bps, l.price_band_bps as i128, GuardError::PriceOutsideBand);
    }

    // G3 daily notional at the oracle price.
    let day = math::utc_day(clock.unix_timestamp);
    let used = if g.day == day { g.day_notional as i128 } else { 0 };
    let after = used + math::notional(p.base_asset_amount as i128, oracle);
    if after > l.daily_notional_cap as i128 {
        return refuse(rule::G3_DAILY_NOTIONAL, after, l.daily_notional_cap as i128, GuardError::DailyNotionalExceeded);
    }

    // G4 worst-case exposure on this market, this order included.
    let exposure = math::worst_case_after(pos.base, pos.open_bids, pos.open_asks, p.direction, p.base_asset_amount);
    if exposure > row.max_exposure_base as i128 {
        return refuse(rule::G4_EXPOSURE, exposure, row.max_exposure_base as i128, GuardError::ExposureExceeded);
    }

    // G5 worst-case leverage over the whole account.
    let (notional, equity) = match account_leverage(ra, &user, &prices, Some((p,))) {
        Ok(v) => v,
        Err(GuardError::OtherSpotBalance) => return refuse(rule::G5_LEVERAGE, 0, 0, GuardError::OtherSpotBalance),
        Err(e) => return Err(e.into()),
    };
    let lev = match math::leverage_bps(notional, equity) {
        Some(v) => v,
        None => return refuse(rule::G5_LEVERAGE, equity, 0, GuardError::NonPositiveEquity),
    };
    if lev > l.max_leverage_bps as i128 {
        return refuse(rule::G5_LEVERAGE, lev, l.max_leverage_bps as i128, GuardError::LeverageExceeded);
    }

    Ok(Outcome::Accept(Decision {
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
    /// G9: exits with an oracle older than this may only be priced on the owner-favourable side of the last oracle
    /// price (sell at or above it, buy at or below it). Must be at least max_oracle_staleness_slots.
    pub exit_max_staleness_slots: u64,
    /// Non-exit orders must carry max_ts no later than now + this many seconds (0: no bound).
    pub max_order_lifetime_secs: u64,
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
    /// Orders accepted (G9 exits included).
    pub accepted_count: u64,
    /// Orders refused, by rule (G2 includes order-shape refusals; G5 includes non-positive equity and unsupported
    /// spot balances; G7 is the pause).
    pub refused_g1: u64,
    pub refused_g2: u64,
    pub refused_g3: u64,
    pub refused_g4: u64,
    pub refused_g5: u64,
    pub refused_g6: u64,
    pub refused_g7: u64,
    pub last_refusal: LastRefusal,
    /// Order ids the guard placed that are still open (0 = free slot). The agent may cancel only these.
    pub placed_order_ids: [u32; 32],
    /// Unused since ids go into free slots; kept so the account layout does not change.
    pub placed_cursor: u8,
    pub cancel_count: u64,
    pub refused_cancels: u64,
    /// The last refusal for each rule (index = rule code, 0..=7), so a later refusal cannot bury an earlier one.
    pub last_refusal_by_rule: [LastRefusal; 8],
    /// G10 (appended so earlier fields keep their offsets): the owner's daily loss cap in quote units (0 = off),
    /// the UTC day of the baseline, the baseline equity and Velocity's net deposits at that moment.
    pub max_daily_loss: u64,
    pub loss_day: i64,
    pub baseline_equity: i64,
    pub baseline_flows: i64,
    pub refused_g10: u64,
    pub last_refusal_g10: LastRefusal,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq, InitSpace)]
pub struct LastRefusal {
    pub rule: u8,
    /// The GuardError code (6000 + variant).
    pub reason: u32,
    pub value: i128,
    pub cap: i128,
    pub slot: u64,
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
    /// The GuardError code naming the refusal (0 when accepted).
    pub reason: u32,
}

/// Emitted for every cancel the agent asks for.
#[event]
pub struct CancelChecked {
    pub guard: Pubkey,
    pub order_id: u32,
    pub accepted: bool,
    pub reason: u32,
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
    #[account(
        mut,
        seeds = [b"guard", velocity_user.key().as_ref()],
        bump = guard.bump,
        has_one = velocity_user,
        constraint = guard.agent != Pubkey::default() @ GuardError::AgentRevoked,
        constraint = guard.agent == agent.key() @ GuardError::NotAgent,
    )]
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
    #[msg("only a positive quote balance is supported: another spot balance or a quote borrow exists")]
    OtherSpotBalance,
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
    #[msg("G9: with a very stale oracle an exit must be priced on the owner-favourable side of the last oracle price")]
    StaleExitUnfavourable,
    #[msg("the agent may cancel only orders the guard placed, by id")]
    CancelNotAllowed,
    #[msg("the order's max_ts is not in the future or is later than the owner's order lifetime allows")]
    OrderLifetimeTooLong,
    #[msg("32 orders the guard placed are already open; cancel one first")]
    TooManyOpenOrders,
    #[msg("G10: today's loss is over the owner's daily loss cap; only exits and cancels pass until the next UTC day")]
    DailyLossExceeded,
    #[msg("Velocity stored no order for this call")]
    OrderNotStored,
}

#[cfg(test)]
mod stored_order_tests {
    use super::*;

    fn slot(order_type: u8, direction: u8, price: u64, offset: i64, start: i64, end: i64, duration: u8) -> velocity::OrderSlot {
        velocity::OrderSlot { order_type, direction, price, oracle_price_offset: offset, auction_start: start, auction_end: end, auction_duration: duration, base: 1, ..Default::default() }
    }

    #[test]
    fn audit_stored_orders() {
        let oracle = 91_390_000;
        // F1: what Velocity stored for an Oracle BUY with no offset and no auction params: no limit at all.
        assert!(stored_breach(&slot(4, 0, 0, 0, 723_020, 15_293_060, 180), oracle, 100).is_some());
        // Oracle BUY with offset +0.50: Velocity's own auction 0.27 to 0.50, inside a 1% band.
        assert!(stored_breach(&slot(4, 0, 0, 500_000, 271_520, 500_000, 15), oracle, 100).is_none());
        // Market BUY at 92.30 with Velocity's auction 92.11 to 92.30: inside the band.
        assert!(stored_breach(&slot(0, 0, 92_300_000, 0, 92_113_020, 92_300_000, 13), oracle, 100).is_none());
        // A BUY whose auction ends 2% above the oracle breaches a 1% band; the same SELL does not (owner-favourable).
        assert!(stored_breach(&slot(1, 0, 91_000_000, 0, 91_000_000, 93_220_000, 10), oracle, 100).is_some());
        assert!(stored_breach(&slot(1, 1, 93_220_000, 0, 93_500_000, 93_220_000, 10), oracle, 100).is_none());
        // A stale exit SELL (limit 0 bps) must not sit below the last price.
        assert!(stored_breach(&slot(1, 1, 91_000_000, 0, 0, 0, 0), oracle, 0).is_some());
        assert!(stored_breach(&slot(1, 1, 91_390_000, 0, 0, 0, 0), oracle, 0).is_none());
    }

    #[test]
    fn daily_loss_takes_deposits_and_withdrawals_out() {
        // baseline 1,000 with 1,000 deposited; equity now 980: a 20 loss
        assert_eq!(daily_loss(1_000, 1_000, 980, 1_000), 20);
        // a 500 deposit since: equity 1,480 is still a 20 loss
        assert_eq!(daily_loss(1_000, 1_000, 1_480, 1_500), 20);
        // a 100 withdrawal since: equity 900 is no loss
        assert_eq!(daily_loss(1_000, 1_000, 900, 900), 0);
    }

    #[test]
    fn stored_max_ts_must_be_in_the_future_and_inside_the_cap() {
        let now = 1_795_230_000;
        let with = |t: i64| velocity::OrderSlot { max_ts: t, ..Default::default() };
        assert!(stored_lifetime_breach(&with(0), now, 60), "0 never expires");
        assert!(stored_lifetime_breach(&with(now), now, 60));
        assert!(stored_lifetime_breach(&with(now + 61), now, 60));
        assert!(!stored_lifetime_breach(&with(now + 60), now, 60));
        assert!(!stored_lifetime_breach(&with(0), now, 0), "no cap set");
    }
}
