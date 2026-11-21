//! REPLAY tests of the guard's limits on Velocity's real devnet binary (cloned devnet state, oracle prices written by
//! the test, real fills from a flow account). Each refusal has an accepted twin that differs in one field, and every
//! other limit is left loose so a broken limit fails only its own test.

use guardrail_tests::*;
use solana_address::Address;
use solana_instruction::AccountMeta;
use solana_keypair::Keypair;
use solana_signer::Signer;

const P0: u64 = 91_390_000; // $91.39

fn setup(limits: Limits) -> (Env, Guarded) {
    let mut env = Env::new();
    env.add_guard_program();
    env.step(1, P0);
    let g = env.guarded(1_000, limits);
    env.step(2, P0);
    (env, g)
}

/// Accepted: the transaction succeeds, the order rests on Velocity, and the event says accepted with `rule`.
#[track_caller]
fn accepted(env: &Env, g: &Guarded, r: &TxResult, o: &Order, rule_code: u8) {
    assert_ok(r);
    assert!(env.has_open_order(&g.owner.pubkey(), o.base, o.price), "order rests on Velocity");
    let ev = events(r);
    assert_eq!(ev.len(), 1, "one OrderChecked event");
    assert!(ev[0].accepted);
    assert_eq!(ev[0].rule, rule_code);
    assert_eq!(ev[0].guard, g.guard);
    assert_eq!(ev[0].base, o.base);
}

/// Refused: the error code, no order on Velocity, and an event naming the rule with its value and cap.
#[track_caller]
fn refused(env: &Env, g: &Guarded, r: &TxResult, o: &Order, c: u32, rule_code: u8) -> OrderEvent {
    assert_code(r, c);
    assert!(!env.has_open_order(&g.owner.pubkey(), o.base, o.price), "no order on Velocity");
    let ev = events(r);
    assert_eq!(ev.len(), 1, "one OrderChecked event in the failed transaction's logs");
    assert!(!ev[0].accepted);
    assert_eq!(ev[0].rule, rule_code);
    ev[0].clone()
}

/// Gives the guarded account a long position of `size` through a real fill (agent bid crossed by a flow account).
fn open_long(env: &mut Env, g: &Guarded, size: u64) {
    let flow = env.trader("flow", 1_000_000);
    let bid = Order::resting(0, size, 91_300_000);
    assert_ok(&env.gplace("agent: bid to open a position", g, bid));
    env.step(2, P0);
    let got = env.cross("flow: sells into the agent's bid", &flow, g, 1, 1_000 * BASE, 91_300_000);
    assert_eq!(got, size as i64, "the agent's bid filled in full");
    env.step(2, P0);
}

// ------------------------------------------------------------------ G1 order size

#[test]
fn g1_refuses_order_one_unit_over_max_size() {
    let mut l = Limits::loose();
    l.max_order_base = 2 * BASE;
    let (mut env, g) = setup(l);
    let bad = Order::resting(0, 2 * BASE + 1, 91_000_000);
    let r = env.gplace("G1 over by one", &g, bad);
    let ev = refused(&env, &g, &r, &bad, gerr::ORDER_TOO_LARGE, rule::G1);
    assert_eq!((ev.value, ev.cap), (2 * BASE as i128 + 1, 2 * BASE as i128));
    let good = Order::resting(0, 2 * BASE, 91_000_000);
    let r = env.gplace("G1 exactly the max", &g, good);
    accepted(&env, &g, &r, &good, rule::ACCEPTED);
}

// ------------------------------------------------------------------ G2 allowlists and order shape

#[test]
fn g2_refuses_market_not_on_allowlist() {
    let (mut env, g) = setup(Limits::loose());
    let mut bad = Order::resting(0, BASE, 91_000_000);
    bad.market_index = 1;
    let r = env.gplace("G2 market 1 not allowed", &g, bad);
    let ev = refused(&env, &g, &r, &bad, gerr::MARKET_NOT_ALLOWED, rule::G2);
    assert_eq!(ev.value, 1);
    let good = Order::resting(0, BASE, 91_000_000);
    let r = env.gplace("G2 market 0 allowed", &g, good);
    accepted(&env, &g, &r, &good, rule::ACCEPTED);
}

#[test]
fn g2_refuses_order_type_not_allowed() {
    let mut l = Limits::loose();
    l.allowed_order_types = T_LIMIT;
    let (mut env, g) = setup(l);
    let mut bad = Order::resting(0, BASE, 91_000_000);
    bad.order_type = 0; // Market
    let r = env.gplace("G2 market order not allowed", &g, bad);
    refused(&env, &g, &r, &bad, gerr::ORDER_TYPE_NOT_ALLOWED, rule::G2);
    let good = Order::resting(0, BASE, 91_000_000);
    let r = env.gplace("G2 limit order allowed", &g, good);
    accepted(&env, &g, &r, &good, rule::ACCEPTED);
}

#[test]
fn g2_refuses_builder_idx_and_builder_fee() {
    let (mut env, g) = setup(Limits::loose());
    let mut bad = Order::resting(0, BASE, 91_000_000);
    bad.builder_idx = Some(0);
    let r = env.gplace("G2 builder_idx set", &g, bad);
    refused(&env, &g, &r, &bad, gerr::BUILDER_FIELDS_REFUSED, rule::G2);
    let mut bad = Order::resting(0, BASE, 91_000_000);
    bad.builder_fee = Some(1);
    let r = env.gplace("G2 builder_fee set", &g, bad);
    refused(&env, &g, &r, &bad, gerr::BUILDER_FIELDS_REFUSED, rule::G2);
    let good = Order::resting(0, BASE, 91_000_000);
    let r = env.gplace("G2 builder fields empty", &g, good);
    accepted(&env, &g, &r, &good, rule::ACCEPTED);
}

#[test]
fn order_shape_refusals_trigger_bitflags_spot_zero() {
    let (mut env, g) = setup(Limits::loose());
    let mut t = Order::resting(0, BASE, 91_000_000);
    t.order_type = 3;
    t.trigger_price = Some(90_000_000);
    let r = env.gplace("trigger limit", &g, t);
    refused(&env, &g, &r, &t, gerr::TRIGGER_ORDERS_REFUSED, rule::SHAPE);
    let mut b = Order::resting(0, BASE, 91_000_000);
    b.bit_flags = 1;
    let r = env.gplace("bit flags", &g, b);
    refused(&env, &g, &r, &b, gerr::BIT_FLAGS_REFUSED, rule::SHAPE);
    let mut s = Order::resting(0, BASE, 91_000_000);
    s.market_type = 0;
    let r = env.gplace("spot market type", &g, s);
    refused(&env, &g, &r, &s, gerr::NOT_PERP, rule::SHAPE);
    let z = Order::resting(0, 0, 91_000_000);
    let r = env.gplace("zero size", &g, z);
    assert_code(&r, gerr::ZERO_SIZE);
    let good = Order::resting(0, BASE, 91_000_000);
    let r = env.gplace("plain limit", &g, good);
    accepted(&env, &g, &r, &good, rule::ACCEPTED);
}

// ------------------------------------------------------------------ G3 daily notional

#[test]
fn g3_refuses_when_daily_notional_cap_would_be_exceeded_and_resets_next_utc_day() {
    let mut l = Limits::loose();
    l.daily_notional_cap = 200_000_000; // 200 dUSDT
    let (mut env, g) = setup(l);
    for i in 0..2u64 {
        let o = Order::resting(0, BASE, 91_000_000 - i * 10_000);
        let r = env.gplace("G3 1 SOL", &g, o);
        accepted(&env, &g, &r, &o, rule::ACCEPTED);
    }
    assert_eq!(env.guard_state(&g).day_notional, 2 * 91_390_000, "notional counted at the oracle price");
    // 182.78 + 0.19 x 91.39 = 200.1441 > 200
    let bad = Order::resting(0, 190_000_000, 90_900_000);
    let r = env.gplace("G3 0.19 SOL over the cap", &g, bad);
    let ev = refused(&env, &g, &r, &bad, gerr::DAILY_NOTIONAL_EXCEEDED, rule::G3);
    assert_eq!((ev.value, ev.cap), (182_780_000 + 17_364_100, 200_000_000));
    // 182.78 + 0.18 x 91.39 = 199.2302 <= 200
    let good = Order::resting(0, 180_000_000, 90_900_000);
    let r = env.gplace("G3 0.18 SOL under the cap", &g, good);
    accepted(&env, &g, &r, &good, rule::ACCEPTED);
    // A new UTC day starts a new total.
    let day = env.guard_state(&g).day;
    let to_next_day = (86_400 - env.now().rem_euclid(86_400) + 10) as u64;
    env.step(to_next_day * 5 / 2, P0);
    let o = Order::resting(0, BASE, 90_800_000);
    let r = env.gplace("G3 next day", &g, o);
    accepted(&env, &g, &r, &o, rule::ACCEPTED);
    let s = env.guard_state(&g);
    assert_eq!(s.day, day + 1);
    assert_eq!(s.day_notional, 91_390_000);
}

// ------------------------------------------------------------------ G4 worst-case exposure

#[test]
fn g4_refuses_bid_that_takes_worst_case_long_over_cap() {
    let mut l = Limits::loose();
    l.markets[0] = (0, 2 * BASE);
    let (mut env, g) = setup(l);
    open_long(&mut env, &g, BASE);
    let o = Order::resting(0, 500_000_000, 91_000_000);
    let r = env.gplace("G4 rest 0.5 (worst 1.5)", &g, o);
    accepted(&env, &g, &r, &o, rule::ACCEPTED);
    let bad = Order::resting(0, 600_000_000, 90_900_000);
    let r = env.gplace("G4 0.6 more (worst 2.1)", &g, bad);
    let ev = refused(&env, &g, &r, &bad, gerr::EXPOSURE_EXCEEDED, rule::G4);
    assert_eq!((ev.value, ev.cap), (2_100_000_000, 2 * BASE as i128));
    let good = Order::resting(0, 500_000_000, 90_900_000);
    let r = env.gplace("G4 0.5 more (worst 2.0)", &g, good);
    accepted(&env, &g, &r, &good, rule::ACCEPTED);
    let (base, _, bids, asks) = env.totals(&g.owner.pubkey());
    assert_eq!((base, bids, asks), (BASE as i64, BASE as i64, 0), "raw account: base 1 + bids 1 = cap 2");
}

#[test]
fn g4_refuses_ask_that_takes_worst_case_short_over_cap() {
    let mut l = Limits::loose();
    l.markets[0] = (0, 2 * BASE);
    let (mut env, g) = setup(l);
    open_long(&mut env, &g, BASE);
    // long 1, ask 3.1 -> worst short 2.1
    let bad = Order::resting(1, 3_100_000_000, 92_000_000);
    let r = env.gplace("G4 ask 3.1 (worst short 2.1)", &g, bad);
    let ev = refused(&env, &g, &r, &bad, gerr::EXPOSURE_EXCEEDED, rule::G4);
    assert_eq!(ev.value, 2_100_000_000);
    let good = Order::resting(1, 3 * BASE, 92_000_000);
    let r = env.gplace("G4 ask 3.0 (worst short 2.0)", &g, good);
    accepted(&env, &g, &r, &good, rule::ACCEPTED);
}

#[test]
fn g4_sums_every_slot_for_the_market_not_the_first_match() {
    // Craft the account so slot 0 is empty (it reads market_index 0 with zeros) and slot 3 holds a 1.5 SOL long on
    // market 0. A first-match lookup would see zero exposure.
    let mut l = Limits::loose();
    l.markets[0] = (0, 2 * BASE);
    let (mut env, g) = setup(l);
    let mut a = env.svm.get_account(&g.user).unwrap();
    let o = 424 + 3 * 80;
    a.data[o + 8..o + 16].copy_from_slice(&1_500_000_000i64.to_le_bytes());
    a.data[o + 16..o + 24].copy_from_slice(&(-137_085_000i64).to_le_bytes());
    a.data[o + 76..o + 78].copy_from_slice(&0u16.to_le_bytes());
    env.svm.set_account(g.user, a).unwrap();
    let bad = Order::resting(0, 600_000_000, 91_000_000);
    let r = env.gplace("G4 crafted slot 3: 0.6 more (worst 2.1)", &g, bad);
    let ev = refused(&env, &g, &r, &bad, gerr::EXPOSURE_EXCEEDED, rule::G4);
    assert_eq!(ev.value, 2_100_000_000);
}

// ------------------------------------------------------------------ G5 leverage

/// Largest bid (in order steps of 1e5) the leverage cap allows, computed from raw account bytes in the test.
fn max_bid_for_leverage(env: &Env, g: &Guarded, price: u64, cap_bps: i128) -> u64 {
    let (base, quote, bids, asks) = env.totals(&g.owner.pubkey());
    let upnl = base as i128 * price as i128 / BASE as i128 + quote as i128;
    let equity = env.raw_collateral(&g.owner.pubkey()) + upnl;
    let max_notional = equity * cap_bps / 10_000;
    let worst_now = (base as i128 + bids as i128).abs().max((base as i128 + asks as i128).abs());
    let room = max_notional * BASE as i128 / price as i128 - worst_now;
    (room as u64) / 100_000 * 100_000
}

#[test]
fn g5_refuses_order_that_takes_worst_case_leverage_over_cap() {
    let mut l = Limits::loose();
    l.max_leverage_bps = 30_000; // 3x
    let (mut env, g) = setup(l);
    let max = max_bid_for_leverage(&env, &g, P0, 30_000);
    assert!(max > 32 * BASE && max < 33 * BASE, "1000 dUSDT x 3 / 91.39 is about 32.8 SOL, got {max}");
    let bad = Order::resting(0, max + 100_000, 90_000_000);
    let r = env.gplace("G5 one step over 3x", &g, bad);
    let ev = refused(&env, &g, &r, &bad, gerr::LEVERAGE_EXCEEDED, rule::G5);
    assert!(ev.value > 30_000 && ev.cap == 30_000);
    let good = Order::resting(0, max, 90_000_000);
    let r = env.gplace("G5 at 3x", &g, good);
    accepted(&env, &g, &r, &good, rule::ACCEPTED);
}

#[test]
fn g5_counts_unrealized_pnl_so_a_falling_price_shrinks_room() {
    let mut l = Limits::loose();
    l.max_leverage_bps = 30_000;
    let (mut env, g) = setup(l);
    open_long(&mut env, &g, 10 * BASE);
    let room_before = max_bid_for_leverage(&env, &g, P0, 30_000);
    let mut price = P0;
    for _ in 0..7 {
        price = price * 99 / 100;
        env.step(10, price);
    }
    let room_after = max_bid_for_leverage(&env, &g, price, 30_000);
    assert!(room_after < room_before, "a loss lowers equity and the allowed size");
    let bad = Order::resting(0, room_after + 100_000, price - 1_000_000);
    let r = env.gplace("G5 after the drop, one step over", &g, bad);
    refused(&env, &g, &r, &bad, gerr::LEVERAGE_EXCEEDED, rule::G5);
    let good = Order::resting(0, room_after, price - 1_000_000);
    let r = env.gplace("G5 after the drop, at the cap", &g, good);
    accepted(&env, &g, &r, &good, rule::ACCEPTED);
}

#[test]
fn g5_refuses_when_an_open_position_market_is_missing() {
    let (mut env, g) = setup(Limits::loose());
    open_long(&mut env, &g, BASE);
    let o = Order::resting(0, BASE, 91_000_000);
    let no_perp = [AccountMeta::new_readonly(SOL_ORACLE, false), AccountMeta::new_readonly(USDT_ORACLE, false), AccountMeta::new(SPOT0, false)];
    let agent = g.agent.insecure_clone();
    let r = env.gplace_as("G5 without the perp market account", &g, &agent, o, &no_perp);
    assert_code(&r, gerr::MISSING_MARKET_ACCOUNT);
    let r = env.gplace("G5 with it", &g, o);
    accepted(&env, &g, &r, &o, rule::ACCEPTED);
}

#[test]
fn guard_ignores_a_look_alike_oracle_at_another_address() {
    let (mut env, g) = setup(Limits::loose());
    let fake = Address::new_unique();
    let mut acc = env.svm.get_account(&SOL_ORACLE).unwrap();
    acc.data[8..16].copy_from_slice(&(50_000_000_00i64).to_le_bytes()); // claims $50
    env.svm.set_account(fake, acc).unwrap();
    let o = Order::resting(0, BASE, 91_000_000);
    let metas = [AccountMeta::new_readonly(fake, false), AccountMeta::new_readonly(USDT_ORACLE, false), AccountMeta::new(SPOT0, false), AccountMeta::new(PERP0, false)];
    let agent = g.agent.insecure_clone();
    let r = env.gplace_as("look-alike oracle", &g, &agent, o, &metas);
    assert_code(&r, gerr::MISSING_MARKET_ACCOUNT);
}

// ------------------------------------------------------------------ G6 price band and stale oracle

#[test]
fn g6_refuses_limit_price_outside_band() {
    let mut l = Limits::loose();
    l.price_band_bps = 100; // 1% of 91.39 = 0.9139
    let (mut env, g) = setup(l);
    let bad = Order::resting(0, BASE, 90_470_000); // 0.92 under
    let r = env.gplace("G6 bid 0.92 under", &g, bad);
    let ev = refused(&env, &g, &r, &bad, gerr::PRICE_OUTSIDE_BAND, rule::G6);
    assert_eq!(ev.cap, 100);
    let good = Order::resting(0, BASE, 90_480_000); // 0.91 under
    let r = env.gplace("G6 bid 0.91 under", &g, good);
    accepted(&env, &g, &r, &good, rule::ACCEPTED);
    let bad = Order::resting(1, BASE, 92_310_000);
    let r = env.gplace("G6 ask 0.92 over", &g, bad);
    refused(&env, &g, &r, &bad, gerr::PRICE_OUTSIDE_BAND, rule::G6);
    let good = Order::resting(1, BASE, 92_300_000);
    let r = env.gplace("G6 ask 0.91 over", &g, good);
    accepted(&env, &g, &r, &good, rule::ACCEPTED);
}

#[test]
fn g6_refuses_oracle_offset_outside_band() {
    let mut l = Limits::loose();
    l.price_band_bps = 100;
    let (mut env, g) = setup(l);
    let mut bad = Order::resting(0, BASE, 0);
    bad.order_type = 4;
    bad.oracle_price_offset = Some(-920_000);
    let r = env.gplace("G6 oracle offset -0.92", &g, bad);
    refused(&env, &g, &r, &bad, gerr::PRICE_OUTSIDE_BAND, rule::G6);
    let mut good = bad;
    good.oracle_price_offset = Some(-910_000);
    let r = env.gplace("G6 oracle offset -0.91", &g, good);
    assert_ok(&r);
    assert!(events(&r)[0].accepted);
}

#[test]
fn g6_refuses_auction_price_outside_band() {
    let mut l = Limits::loose();
    l.price_band_bps = 100;
    let (mut env, g) = setup(l);
    let mut bad = Order::limit(0, BASE, 91_000_000);
    bad.auction = Some((10, 90_400_000, 91_000_000)); // start 0.99 under
    let r = env.gplace("G6 auction start outside", &g, bad);
    refused(&env, &g, &r, &bad, gerr::PRICE_OUTSIDE_BAND, rule::G6);
    let mut good = bad;
    good.auction = Some((10, 90_500_000, 91_000_000));
    let r = env.gplace("G6 auction start inside", &g, good);
    assert_ok(&r);
    assert!(events(&r)[0].accepted);
}

#[test]
fn g6_refuses_stale_oracle() {
    let mut l = Limits::loose();
    l.max_oracle_staleness_slots = 10;
    let (mut env, g) = setup(l);
    env.step(1, P0); // oracle posted now
    env.advance(11);
    let o = Order::resting(0, BASE, 91_000_000);
    let r = env.gplace("G6 oracle 11 slots old", &g, o);
    let ev = refused(&env, &g, &r, &o, gerr::STALE_ORACLE, rule::G6);
    assert_eq!((ev.value, ev.cap), (11, 10));
    env.step(1, P0);
    env.advance(10);
    let r = env.gplace("G6 oracle 10 slots old", &g, o);
    accepted(&env, &g, &r, &o, rule::ACCEPTED);
}

// ------------------------------------------------------------------ G7 owner-only controls

#[test]
fn g7_only_the_owner_sets_limits() {
    let (mut env, g) = setup(Limits::loose());
    let mut l = Limits::loose();
    l.max_order_base = 5 * BASE;
    let agent = g.agent.insecure_clone();
    assert_code(&env.set_limits("agent tries set_limits", &g, &agent, &l), gerr::NOT_OWNER);
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_limits("owner set_limits", &g, &owner, &l));
    let o = Order::resting(0, 5 * BASE + 100_000, 91_000_000);
    assert_code(&env.gplace("new G1 limit applies", &g, o), gerr::ORDER_TOO_LARGE);
}

#[test]
fn g7_revoke_and_rotate_agent() {
    let (mut env, g) = setup(Limits::loose());
    let o = Order::resting(0, BASE, 91_000_000);
    let owner = g.owner.insecure_clone();
    let agent = g.agent.insecure_clone();
    assert_code(&env.set_agent("agent tries to rotate itself", &g, &agent, &Address::new_unique()), gerr::NOT_OWNER);
    assert_ok(&env.set_agent("owner revokes", &g, &owner, &Address::default()));
    assert_code(&env.gplace("revoked agent", &g, o), gerr::AGENT_REVOKED);
    let new_agent = Keypair::new();
    env.svm.airdrop(&new_agent.pubkey(), 1_000_000_000).unwrap();
    assert_ok(&env.set_agent("owner rotates", &g, &owner, &new_agent.pubkey()));
    assert_code(&env.gplace("old agent after rotation", &g, o), gerr::NOT_AGENT);
    let r = env.gplace_as("new agent", &g, &new_agent, o, &[]);
    assert_ok(&r);
}

#[test]
fn g7_pause_blocks_new_orders_but_not_cancels() {
    let (mut env, g) = setup(Limits::loose());
    let o = Order::resting(0, BASE, 91_000_000);
    let r = env.gplace("before pause", &g, o);
    accepted(&env, &g, &r, &o, rule::ACCEPTED);
    let owner = g.owner.insecure_clone();
    let agent = g.agent.insecure_clone();
    assert_code(&env.set_paused("agent tries to unpause", &g, &agent, false), gerr::NOT_OWNER);
    assert_ok(&env.set_paused("owner pauses", &g, &owner, true));
    let o2 = Order::resting(0, BASE, 90_900_000);
    let r = env.gplace("paused", &g, o2);
    refused(&env, &g, &r, &o2, gerr::PAUSED, rule::G7);
    assert_ok(&env.gcancel("cancel while paused", &g, None));
    assert!(env.user(&g.owner.pubkey()).open_orders.is_empty());
    assert_ok(&env.set_paused("owner unpauses", &g, &owner, false));
    let r = env.gplace("after unpause", &g, o2);
    accepted(&env, &g, &r, &o2, rule::ACCEPTED);
}

#[test]
fn g7_limits_are_validated() {
    let (mut env, g) = setup(Limits::loose());
    let owner = g.owner.insecure_clone();
    let mut l = Limits::loose();
    l.price_band_bps = 0;
    assert_code(&env.set_limits("band 0", &g, &owner, &l), gerr::INVALID_LIMITS);
    let mut l = Limits::loose();
    l.allowed_order_types |= 1 << 3;
    assert_code(&env.set_limits("trigger type bit", &g, &owner, &l), gerr::INVALID_LIMITS);
    let mut l = Limits::loose();
    l.markets[1] = (0, BASE);
    assert_code(&env.set_limits("duplicate market row", &g, &owner, &l), gerr::INVALID_LIMITS);
    let mut l = Limits::loose();
    l.max_leverage_bps = 0;
    assert_code(&env.set_limits("leverage 0", &g, &owner, &l), gerr::INVALID_LIMITS);
    assert_ok(&env.set_limits("valid", &g, &owner, &Limits::loose()));
}

#[test]
fn init_guard_requires_the_velocity_user_authority() {
    let mut env = Env::new();
    env.add_guard_program();
    env.step(1, P0);
    let owner = env.trader("owner", 100);
    let stranger = env.trader("stranger", 100);
    let agent = Address::new_unique();
    // stranger signs init for the owner's Velocity user
    let mut ix = Env::init_guard_ix(&owner.pubkey(), &agent, &Limits::loose());
    ix.accounts[0] = AccountMeta::new(stranger.pubkey(), true);
    assert_code(&env.send("stranger init_guard", vec![ix], &[&stranger]), gerr::NOT_USER_AUTHORITY);
    // not a Velocity account
    let mut ix = Env::init_guard_ix(&owner.pubkey(), &agent, &Limits::loose());
    let fake = Address::new_unique();
    env.svm.airdrop(&fake, 1_000_000).unwrap();
    ix.accounts[1] = AccountMeta::new_readonly(fake, false);
    ix.accounts[2] = AccountMeta::new(guard_pda(&fake), false);
    assert_code(&env.send("init_guard on a non-Velocity account", vec![ix], &[&owner]), gerr::NOT_VELOCITY_USER);
    let ix = Env::init_guard_ix(&owner.pubkey(), &agent, &Limits::loose());
    assert_ok(&env.send("owner init_guard", vec![ix], &[&owner]));
}

// ------------------------------------------------------------------ G9 exits and cancels always allowed

fn exit_setup() -> (Env, Guarded) {
    let (mut env, g) = setup(Limits::loose());
    open_long(&mut env, &g, BASE);
    (env, g)
}

fn tighten(env: &mut Env, g: &Guarded, f: impl Fn(&mut Limits)) {
    let mut l = Limits::loose();
    f(&mut l);
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_limits("owner tightens", g, &owner, &l));
}

fn exit_is_allowed_where_new_order_is_refused(env: &mut Env, g: &Guarded, new_code: u32) {
    let new = Order::resting(0, 100_000_000, 91_000_000);
    assert_code(&env.gplace("new risk refused", g, new), new_code);
    let mut exit = Order::resting(1, BASE, 91_500_000);
    exit.reduce_only = true;
    let r = env.gplace("reduce-only exit", g, exit);
    accepted(env, g, &r, &exit, rule::G9);
}

#[test]
fn g9_exit_allowed_when_daily_notional_is_spent() {
    let (mut env, g) = exit_setup();
    tighten(&mut env, &g, |l| l.daily_notional_cap = 1);
    exit_is_allowed_where_new_order_is_refused(&mut env, &g, gerr::DAILY_NOTIONAL_EXCEEDED);
}

#[test]
fn g9_exit_allowed_when_exposure_is_over_cap() {
    let (mut env, g) = exit_setup();
    tighten(&mut env, &g, |l| l.markets[0] = (0, 500_000_000));
    exit_is_allowed_where_new_order_is_refused(&mut env, &g, gerr::EXPOSURE_EXCEEDED);
}

#[test]
fn g9_exit_allowed_when_leverage_is_over_cap() {
    let (mut env, g) = exit_setup();
    tighten(&mut env, &g, |l| l.max_leverage_bps = 1);
    exit_is_allowed_where_new_order_is_refused(&mut env, &g, gerr::LEVERAGE_EXCEEDED);
}

#[test]
fn g9_exit_allowed_when_paused_or_market_delisted_or_oracle_stale() {
    let (mut env, g) = exit_setup();
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_paused("owner pauses", &g, &owner, true));
    exit_is_allowed_where_new_order_is_refused(&mut env, &g, gerr::PAUSED);
    assert_ok(&env.gcancel("cancel the exit", &g, None));
    assert_ok(&env.set_paused("owner unpauses", &g, &owner, false));
    tighten(&mut env, &g, |l| l.markets[0] = (5, BASE));
    exit_is_allowed_where_new_order_is_refused(&mut env, &g, gerr::MARKET_NOT_ALLOWED);
    assert_ok(&env.gcancel("cancel the exit", &g, None));
    tighten(&mut env, &g, |l| l.max_oracle_staleness_slots = 1);
    env.advance(5);
    exit_is_allowed_where_new_order_is_refused(&mut env, &g, gerr::STALE_ORACLE);
}

#[test]
fn g9_exit_actually_closes_the_position_under_tight_limits() {
    let (mut env, g) = exit_setup();
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_paused("owner pauses", &g, &owner, true));
    let mut exit = Order::resting(1, BASE, 91_500_000);
    exit.reduce_only = true;
    assert_ok(&env.gplace("reduce-only exit while paused", &g, exit));
    env.step(2, P0);
    let flow = env.trader("flow2", 1_000_000);
    let got = env.cross("flow buys through the exit", &flow, &g, 0, 1_000 * BASE, 91_500_000);
    assert_eq!(got, -(BASE as i64));
    assert_eq!(env.totals(&g.owner.pubkey()).0, 0, "position closed");
}

#[test]
fn g9_reduce_only_that_is_not_an_exit_goes_through_the_limits() {
    let (mut env, g) = exit_setup();
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_paused("owner pauses", &g, &owner, true));
    let mut same_side = Order::resting(0, 500_000_000, 91_000_000);
    same_side.reduce_only = true;
    assert_code(&env.gplace("reduce-only BUY while long", &g, same_side), gerr::PAUSED);
    let mut too_big = Order::resting(1, BASE + 100_000, 91_500_000);
    too_big.reduce_only = true;
    assert_code(&env.gplace("reduce-only SELL larger than the position", &g, too_big), gerr::PAUSED);
    let mut no_flag = Order::resting(1, BASE, 91_500_000);
    no_flag.reduce_only = false;
    assert_code(&env.gplace("SELL without reduce_only", &g, no_flag), gerr::PAUSED);
}

// ------------------------------------------------------------------ G8 no withdraw, no other Velocity instruction

#[test]
fn g8_guard_binary_contains_only_place_and_cancel_velocity_instructions() {
    use sha2::{Digest, Sha256};
    let so = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy/guard.so")).unwrap();
    let idl: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/velocity-idl.json")).unwrap()).unwrap();
    let mut found = vec![];
    for ix in idl["instructions"].as_array().unwrap() {
        let name = ix["name"].as_str().unwrap();
        let d: Vec<u8> = Sha256::digest(format!("global:{name}").as_bytes())[..8].to_vec();
        if so.windows(8).any(|w| w == d.as_slice()) {
            found.push(name.to_string());
        }
    }
    found.sort();
    assert_eq!(found, vec!["cancel_order".to_string(), "place_perp_order".to_string()], "only these two Velocity instructions");
}

#[test]
fn g8_agent_cannot_withdraw_or_trade_around_the_guard() {
    use solana_instruction::Instruction;
    let (mut env, g) = setup(Limits::loose());
    let agent = g.agent.insecure_clone();
    let a = agent.pubkey();
    // Velocity place_perp_order on the owner's account, signed by the agent key directly.
    let mut data = disc("place_perp_order").to_vec();
    data.extend(Order::resting(0, BASE, 91_000_000).bytes());
    let mut accounts = vec![AccountMeta::new_readonly(STATE, false), AccountMeta::new(g.user, false), AccountMeta::new_readonly(a, true)];
    accounts.extend(Env::maps());
    let r = env.send("agent places directly on Velocity", vec![Instruction { program_id: VELOCITY, accounts, data }], &[&agent]);
    assert_code(&r, 2003); // ConstraintRaw: can_sign_for_user
    // Velocity withdraw on the owner's account, signed by the agent key.
    let mut data = disc("withdraw").to_vec();
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&1_000_000u64.to_le_bytes());
    data.push(0);
    let signer = Address::find_program_address(&[b"velocity_signer"], &VELOCITY).0;
    let accounts = vec![
        AccountMeta::new_readonly(STATE, false),
        AccountMeta::new(g.user, false),
        AccountMeta::new(stats_pda(&g.owner.pubkey()), false),
        AccountMeta::new_readonly(a, true),
        AccountMeta::new(SPOT0_VAULT, false),
        AccountMeta::new_readonly(signer, false),
        AccountMeta::new(Address::new_unique(), false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(USDT_ORACLE, false),
        AccountMeta::new(SPOT0, false),
    ];
    let r = env.send("agent withdraws directly from Velocity", vec![Instruction { program_id: VELOCITY, accounts, data }], &[&agent]);
    assert!(r.is_err(), "Velocity withdraw is has_one = authority");
}
