#!/usr/bin/env bash
# Planted-bug run: break one limit at a time, rebuild, run the replay tests, show which tests fail, restore from a
# copy (never from git). Expect each plant to fail only the tests written for that limit.
set -uo pipefail
cd "$(dirname "$0")/.."
LIB=programs/guard/src/lib.rs
MATH=programs/guard/src/math.rs
VEL=programs/guard/src/velocity.rs
B1=$(mktemp); B2=$(mktemp); B3=$(mktemp)
cp $LIB $B1; cp $MATH $B2; cp $VEL $B3
restore() { cp $B1 $LIB; cp $B2 $MATH; cp $B3 $VEL; }
plant() { # $1 label, $2 file, $3 python old, $4 python new, $5 "unit" to also run the program's unit tests
  if [ -n "${ONLY:-}" ] && [[ "$1" != *"$ONLY"* ]]; then return; fi  # ONLY=R5 runs just the plants whose label has R5
  echo "=== $1"
  python3 - "$2" "$3" "$4" <<'PY'
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
assert s.count(old) == 1, f"plant site not unique: {old!r}"
open(p, 'w').write(s.replace(old, new))
PY
  if [ $? -ne 0 ]; then echo "PLANT NOT APPLIED, aborting"; restore; exit 1; fi
  if [ -n "${CHECK:-}" ]; then restore; return; fi  # CHECK=1: only confirm every plant site is unique, no builds
  if ! ./scripts/build.sh > notes/build-plant.log 2>&1; then echo "BUILD FAILED, aborting"; tail -5 notes/build-plant.log; restore; exit 1; fi
  (cd tests-litesvm && cargo test --release --no-fail-fast --test limits --test audit --test daily_loss --test audit_r2 --test audit_r3 --test audit_r4 2>&1) | grep -E "\.\.\. FAILED|^test result"
  if [ "${5:-}" = "unit" ]; then cargo test --release --manifest-path programs/guard/Cargo.toml 2>&1 | grep -E "\.\.\. FAILED|^test result: .*passed" | head -2; fi
  restore
}
plant "G1 off by one" $LIB "if p.base_asset_amount > l.max_order_base {" "if p.base_asset_amount > l.max_order_base + 1 {"
plant "G2 market allowlist ignores the index" $LIB "let row = match l.markets.iter().find(|m| m.max_exposure_base > 0 && m.market_index == p.market_index) {" "let row = match l.markets.iter().find(|m| m.max_exposure_base > 0) {"
plant "F2 exits skip the market allowlist" $LIB "        if !l.markets.iter().any(|m| m.max_exposure_base > 0 && m.market_index == p.market_index) {" "        if false {"
plant "G2 order type check removed" $LIB "    };
    if p.order_type > 7 || l.allowed_order_types & (1u8 << p.order_type) == 0 {" "    };
    if p.order_type > 7 {"
plant "G2 builder check removed" $LIB "if p.builder_idx.is_some() || p.builder_fee_tenth_bps.is_some() {" "if false {"
plant "G3 forgets the running total" $LIB "let used = if g.day == day { g.day_notional as i128 } else { 0 };" "let used: i128 = 0;"
plant "G3 never resets on a new day" $LIB "let used = if g.day == day { g.day_notional as i128 } else { 0 };" "let used = g.day_notional as i128;"
plant "G4 ignores this order" $LIB "let exposure = math::worst_case_after(pos.base, pos.open_bids, pos.open_asks, p.direction, p.base_asset_amount);" "let exposure = math::worst_case_base(pos.base, pos.open_bids, pos.open_asks);"
plant "G4 first-match slot lookup" $VEL "for p in self.perp.iter().filter(|p| p.is_active() && p.market_index == market_index) {" "for p in self.perp.iter().filter(|p| p.market_index == market_index).take(1) {"
plant "G5 ignores unrealized PnL" $LIB "upnl += math::notional(t.base as i128, price) + t.quote as i128;" "upnl += 0;"
plant "G5 check removed" $LIB "if lev > l.max_leverage_bps as i128 {" "if false {"
plant "G6 price field skipped" $LIB "if p.price != 0 && !math::within_band(p.price as i128, oracle, band) {" "if false {"
plant "G6 oracle offset skipped" $LIB "if offset != 0 && !math::offset_within_band(offset as i128, oracle, band) {" "if false {"
plant "G6 auction prices skipped" $LIB "        let ok = if relative { math::offset_within_band(a as i128, oracle, band) } else { math::within_band(a as i128, oracle, band) };" "        let ok = true;"
plant "G6 market order without a worst price allowed" $LIB "if p.order_type == order_type::MARKET && p.price == 0 {" "if false {"
plant "G9 exit skips the price band" $LIB "        } else if let Some((bps, _)) = band_breach(p, oracle, l.price_band_bps) {" "        } else if let Some((bps, _)) = None::<(i128, &str)> {"
plant "G5 other spot balances ignored" $LIB "if user.spot.iter().any(|s| s.scaled_balance != 0 && (s.market_index != 0 || s.balance_type == 1)) {" "if false {"
plant "G6 staleness off by one" $LIB "if age > l.max_oracle_staleness_slots {" "if age > l.max_oracle_staleness_slots + 1 {"
plant "G7 pause ignored" $LIB "    if g.paused {
        return refuse" "    if false {
        return refuse"
plant "G7 owner check removed from set_limits" $LIB "#[account(mut, has_one = owner @ GuardError::NotOwner)]" "#[account(mut)]"
plant "G7 revoked agent still trades" $LIB "        constraint = guard.agent != Pubkey::default() @ GuardError::AgentRevoked,
" ""
plant "agent constraint removed (any signer trades)" $LIB "        constraint = guard.agent == agent.key() @ GuardError::NotAgent,
" ""
plant "a refusal fails the transaction instead of being recorded" $LIB "            emit_checked(g.key(), &params, false, r, value, cap, u32::from(reason));
            return Ok(());" "            emit_checked(g.key(), &params, false, r, value, cap, u32::from(reason));
            return Err(reason.into());"
plant "refusal counter for G1 not bumped" $LIB "rule::G1_ORDER_SIZE => g.refused_g1 += 1," "rule::G1_ORDER_SIZE => {}"
plant "G9 exit does not need to oppose the position" $MATH "    opposes && (size as u128 + resting_exits as u128) <= position_base.unsigned_abs() as u128" "    (size as u128 + resting_exits as u128) <= position_base.unsigned_abs() as u128"
plant "F4 resting exits ignored" $MATH "    opposes && (size as u128 + resting_exits as u128) <= position_base.unsigned_abs() as u128" "    opposes && (size as u128) <= position_base.unsigned_abs() as u128"
plant "G9 exits blocked by limits (no bypass)" $LIB "    if math::is_exit(p.reduce_only, p.direction, p.base_asset_amount, pos.base, resting) {" "    if false {"
plant "G8 a third Velocity instruction (withdraw) appears" $VEL "pub const IX_CANCEL_ORDER: [u8; 8] = [95, 129, 237, 240, 8, 49, 223, 132];" "pub const IX_CANCEL_ORDER: [u8; 8] = [95, 129, 237, 240, 8, 49, 223, 132];
pub const IX_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];"
plant "post-trade check off by one (refuses at the cap)" $LIB "if exposure > d.exposure_cap as i128 || lev > l.max_leverage_bps as i128 {" "if exposure >= d.exposure_cap as i128 || lev > l.max_leverage_bps as i128 {"
plant "stale exit favourable-side check removed" $LIB "            if let Some(what) = unfavourable_for_stale_exit(p, oracle) {" "            if let Some(what) = None::<&str> {"
plant "stale exit threshold ignored (always the band)" $LIB "        if age > l.exit_max_staleness_slots {" "        if false {"
plant "F1 oracle order without an offset allowed" $LIB "    if p.order_type == order_type::ORACLE && off0 == 0 {" "    if false {"
plant "F1 stored-order check after the CPI removed (defense in depth: the pre-check refuses first)" $LIB "        if let Some(x) = stored_breach(o, oracle, limit) {" "        if let Some(x) = None::<i128> {"
plant "F1 stored-order breach rule broken (unit tests on the audit's stored orders)" $LIB "    prices.into_iter().find(|&x| if o.direction == 0 { x > oracle as i128 + edge } else { x < oracle as i128 - edge })" "    prices.into_iter().find(|&x| if o.direction == 0 { x > oracle as i128 + edge * 100 } else { x < oracle as i128 - edge })" unit
plant "F2 exits skip the order-type allowlist" $LIB "        if p.order_type > 7 || l.allowed_order_types & (1u8 << p.order_type) == 0 {
            return refuse(rule::G2_ALLOWLIST, p.order_type as i128, l.allowed_order_types as i128, GuardError::OrderTypeNotAllowed);
        }
        // Exits obey the order lifetime too" "        // Exits obey the order lifetime too"
plant "F3 agent may cancel any order" $LIB "            Some(id) if id != 0 => g.placed_order_ids.contains(&id)," "            Some(_) => true,"
plant "F3 agent may cancel all" $LIB "            _ => false,
        };" "            None => true,
            _ => false,
        };"
plant "INFO order lifetime ignored" $LIB "    (life > l.max_order_lifetime_secs as i128).then(|| life.min(i64::MAX as i128))" "    (false && life > 0).then(|| life)"
plant "INFO last refusal by rule not kept" $LIB "            g.last_refusal_by_rule[(r as usize).min(7)] = lr;" ""
plant "R5 lifetime: max_ts 0 or in the past passes (life = max_ts - now)" $LIB "        Some(t) if t as i128 > now as i128 => t as i128 - now as i128," "        Some(t) => t as i128 - now as i128,"
plant "R5 placed ids never pruned" $LIB "        if *id != 0 && !open.contains(id) {" "        if false && *id != 0 && !open.contains(id) {"
plant "R5 a new id evicts a live one" $LIB "        match g.placed_order_ids.iter_mut().find(|x| **x == 0) {" "        match g.placed_order_ids.iter_mut().next() {"
plant "R5 no refusal when 32 guard orders are open" $LIB "        if !matches!(outcome, Outcome::Refuse { .. }) && !ctx.accounts.guard.placed_order_ids.contains(&0) {" "        if false {"
plant "R5 stored max_ts not checked after the CPI (unit tests)" $LIB "    cap_secs > 0 && (o.max_ts <= now || o.max_ts as i128 - now as i128 > cap_secs as i128)" "    cap_secs > 0 && o.max_ts as i128 - now as i128 > cap_secs as i128" unit
plant "R6 G10 check removed" $LIB "        if increases && loss > g.max_daily_loss as i128 {" "        if false {"
plant "R6 G10 ignores deposits and withdrawals" $LIB "    baseline_equity + (flows - baseline_flows) - equity" "    baseline_equity - equity + 0 * (flows - baseline_flows)" unit
plant "R6 G10 baseline re-taken on every call" $LIB "    if g.max_daily_loss > 0 && g.loss_day != today {" "    if g.max_daily_loss > 0 {"
plant "R6 G10 baseline never resets on a new day" $LIB "    if g.max_daily_loss > 0 && g.loss_day != today {" "    if g.max_daily_loss > 0 && g.loss_day == 0 {"
plant "R6 G10 refusal filed under G7" $LIB "                rule::G10_DAILY_LOSS => g.refused_g10 += 1," "                rule::G10_DAILY_LOSS => g.refused_g7 += 1,"
plant "R6 an order Velocity did not store counts as accepted" $LIB "        if placed.is_empty() {" "        if false {"
plant "R7 G10 baseline not taken on the first cancel of the day" $LIB "        observe(&mut ctx)?;
        let g = &ctx.accounts.guard;
        let allowed" "        let g = &ctx.accounts.guard;
        let allowed"
plant "R8 G4 and G5 also refuse true exits that are not flagged reduce-only (exit trap)" $LIB "    let increases = !math::is_exit(true, p.direction, p.base_asset_amount, pos.base, resting_same_side);" "    let increases = true || !math::is_exit(true, p.direction, p.base_asset_amount, pos.base, resting_same_side);"
plant "R8 an order that keeps exposure equal by flipping is waived (the review case)" $LIB "    let increases = !math::is_exit(true, p.direction, p.base_asset_amount, pos.base, resting_same_side);" "    let increases = exposure > exposure_before;"
plant "R9 N2 a new day's baseline ignores the last equity seen" $LIB "    if let Some(x) = last_seen {
        b = b.max(adj(x));
    }" "    let _ = last_seen;"
plant "R9 N2 checkpoint accepts any Velocity account" $LIB "    #[account(mut, has_one = velocity_user)]
    pub guard: Account<'info, Guard>,
    /// CHECK: read only, bound to the guard by has_one" "    #[account(mut)]
    pub guard: Account<'info, Guard>,
    /// CHECK: read only, bound to the guard by has_one"
plant "R9 N3 exits skip the order lifetime" $LIB "        // after the price moves. An exit can always be placed again, so this never traps a position.
        if let Some(life) = lifetime_breach(l, p, clock.unix_timestamp) {" "        // after the price moves. An exit can always be placed again, so this never traps a position.
        if let Some(life) = None::<i128> {"
plant "R9 N4 the owner's reduce-only orders count against the agent's exits" $VEL "&& o.direction == direction && only_ids.contains(&o.order_id))" "&& o.direction == direction && (only_ids.contains(&o.order_id) || o.order_id > 0))"
plant "R9 N5 surplus reduce-only orders pass" $LIB "    if p.reduce_only {
        return refuse(rule::G2_ALLOWLIST, (p.base_asset_amount as i128)" "    if false {
        return refuse(rule::G2_ALLOWLIST, (p.base_asset_amount as i128)"
plant "R10 an observation is skipped when the caller leaves accounts out" $LIB "            Err(GuardError::MissingMarketAccount) => return err!(GuardError::MissingMarketAccount),
            Err(_) => return Ok(()),
        }
    }" "            Err(_) => return Ok(()),
        }
    }"
plant "R10 a first-hour checkpoint does not mark the day at midnight" $LIB "    if direct {
        return eq;
    }
    let adj" "    let _ = direct;
    let adj"
plant "R11 anyone's first-hour checkpoint marks the day at midnight" $LIB "        let trusted = caller == g.owner || (g.keeper != Pubkey::default() && caller == g.keeper);" "        let trusted = caller != Pubkey::default() || caller == g.owner || g.keeper == Pubkey::default();"
plant "R11 a state error (stale or unsupported oracle) fails cancels and exits" $LIB "            Err(GuardError::MissingMarketAccount) => return err!(GuardError::MissingMarketAccount),
            Err(_) => return Ok(()),
        }
    }" "            Err(e) => return Err(e.into()),
        }
    }"
plant "R12 anyone may migrate or close a guard" $LIB "    require_keys_eq!(guard_owner, *owner, GuardError::NotOwner);
    let (pda, _)" "    let _ = guard_owner;
    let (pda, _)"
plant "R12 migrate does not grow the account" $LIB "        guard.realloc(new_len, true)?;" "        guard.realloc(old_len, true)?;"
plant "R12 close keeps the rent" $LIB "        **owner.try_borrow_mut_lamports()? += lamports;
        **guard.try_borrow_mut_lamports()? = 0;" "        let _ = (&owner, lamports);"
plant "R12 a daily loss cap without a keeper" $LIB "        require!(max_daily_loss == 0 || ctx.accounts.guard.keeper != Pubkey::default(), GuardError::KeeperRequired);" ""
plant "R13 migrate accepts any shorter length" $LIB "        require!(MIGRATABLE_LENGTHS.contains(&guard.data_len()), GuardError::BadGuardAccount);" "        require!(guard.data_len() < new_len, GuardError::BadGuardAccount);"
plant "R13 a new day's baseline ignores the previous day's high" $LIB "    if let Some(x) = day_high {
        b = b.max(adj(x));
    }" "    let _ = day_high;"
plant "R13 the day's high does not start from its baseline" $LIB "            h = h.max(adj(g.baseline_equity, g.baseline_flows));" ""
plant "R13 the keeper can be removed while a cap is set" $LIB "        require!(keeper != Pubkey::default() || ctx.accounts.guard.max_daily_loss == 0, GuardError::KeeperRequired);" ""
plant "R14 a guard upgraded mid-day forgets the high it saw before" $LIB "            h = h.max(adj(g.last_seen_equity, g.last_seen_flows));" ""
echo "=== restored"
cmp $B1 $LIB && cmp $B2 $MATH && cmp $B3 $VEL && echo "sources restored byte for byte"
./scripts/build.sh > notes/build.log 2>&1
(cd tests-litesvm && cargo test --release --no-fail-fast 2>&1) | grep -E "^test result"
