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
plant() { # $1 label, $2 file, $3 python old, $4 python new
  echo "=== $1"
  python3 - "$2" "$3" "$4" <<'PY'
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
assert s.count(old) == 1, f"plant site not unique: {old!r}"
open(p, 'w').write(s.replace(old, new))
PY
  if ! ./scripts/build.sh > notes/build-plant.log 2>&1; then echo "BUILD FAILED, aborting"; tail -5 notes/build-plant.log; restore; exit 1; fi
  (cd tests-litesvm && cargo test --release --no-fail-fast --test limits 2>&1) | grep -E "\.\.\. FAILED|^test result"
  restore
}
plant "G1 off by one" $LIB "if p.base_asset_amount > l.max_order_base {" "if p.base_asset_amount > l.max_order_base + 1 {"
plant "G2 market allowlist ignores the index" $LIB "m.max_exposure_base > 0 && m.market_index == p.market_index" "m.max_exposure_base > 0"
plant "G2 order type check removed" $LIB "if p.order_type > 7 || l.allowed_order_types & (1u8 << p.order_type) == 0 {" "if p.order_type > 7 {"
plant "G2 builder check removed" $LIB "if p.builder_idx.is_some() || p.builder_fee_tenth_bps.is_some() {" "if false {"
plant "G3 forgets the running total" $LIB "let used = if g.day == day { g.day_notional as i128 } else { 0 };" "let used: i128 = 0;"
plant "G3 never resets on a new day" $LIB "let used = if g.day == day { g.day_notional as i128 } else { 0 };" "let used = g.day_notional as i128;"
plant "G4 ignores this order" $LIB "let exposure = math::worst_case_after(pos.base, pos.open_bids, pos.open_asks, p.direction, p.base_asset_amount);" "let exposure = math::worst_case_base(pos.base, pos.open_bids, pos.open_asks);"
plant "G4 first-match slot lookup" $VEL "for p in self.perp.iter().filter(|p| p.is_active() && p.market_index == market_index) {" "for p in self.perp.iter().filter(|p| p.market_index == market_index).take(1) {"
plant "G5 ignores unrealized PnL" $LIB "upnl += math::notional(t.base as i128, price) + t.quote as i128;" "upnl += 0;"
plant "G5 check removed" $LIB "if lev > l.max_leverage_bps as i128 {" "if false {"
plant "G6 price field skipped" $LIB "if p.price != 0 && !math::within_band(p.price as i128, oracle, band) {" "if false {"
plant "G6 oracle offset skipped" $LIB "if offset != 0 && !math::offset_within_band(offset as i128, oracle, band) {" "if false {"
plant "G6 auction prices skipped" $LIB "for a in [p.auction_start_price, p.auction_end_price].into_iter().flatten() {" "for a in [None::<i64>].into_iter().flatten() {"
plant "G6 market order without a worst price allowed" $LIB "if p.order_type == order_type::MARKET && p.price == 0 {" "if false {"
plant "G9 exit skips the price band" $LIB "        if let Some((bps, _)) = band_breach(p, oracle, l.price_band_bps) {" "        if let Some((bps, _)) = None::<(i128, &str)> {"
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
plant "G9 exit does not need to oppose the position" $MATH "    opposes && (size as u128) <= position_base.unsigned_abs() as u128" "    (size as u128) <= position_base.unsigned_abs() as u128"
plant "G9 exits blocked by limits (no bypass)" $LIB "    if math::is_exit(p.reduce_only, p.direction, p.base_asset_amount, pos.base) {" "    if false {"
plant "G8 a third Velocity instruction (withdraw) appears" $VEL "pub const IX_CANCEL_ORDER: [u8; 8] = [95, 129, 237, 240, 8, 49, 223, 132];" "pub const IX_CANCEL_ORDER: [u8; 8] = [95, 129, 237, 240, 8, 49, 223, 132];
pub const IX_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];"
plant "post-trade check off by one (refuses at the cap)" $LIB "if exposure > d.exposure_cap as i128 || lev > l.max_leverage_bps as i128 {" "if exposure >= d.exposure_cap as i128 || lev > l.max_leverage_bps as i128 {"
echo "=== restored"
cmp $B1 $LIB && cmp $B2 $MATH && cmp $B3 $VEL && echo "sources restored byte for byte"
./scripts/build.sh > notes/build.log 2>&1
(cd tests-litesvm && cargo test --release --no-fail-fast 2>&1) | grep -E "^test result"
