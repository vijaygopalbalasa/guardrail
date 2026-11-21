//! Audit findings F1 to F4 and the INFO items (security review of Nov 21), ported from the reviewer's probes as
//! red-first tests with accepted twins. REPLAY on Velocity's real devnet binary.

use guardrail_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const P0: u64 = 91_390_000;

fn setup(l: Limits) -> (Env, Guarded) {
    let mut env = Env::new();
    env.add_guard_program();
    env.step(1, P0);
    let g = env.guarded(10_000, l);
    env.step(2, P0);
    (env, g)
}

fn tight() -> Limits {
    let mut l = Limits::loose();
    l.price_band_bps = 100; // 1%
    l
}

/// An Oracle order with no offset: Velocity stores no limit, so after the auction it fills at any price.
fn oracle_no_limit(direction: u8) -> Order {
    let mut o = Order::limit(direction, BASE, 0);
    o.order_type = 4;
    o.auction = Some((10, 0, 0));
    o
}

fn open_long(env: &mut Env, g: &Guarded) {
    let flow = env.trader("flow", 1_000_000);
    assert_ok(&env.gplace("agent bid", g, Order::resting(0, BASE, 91_300_000)));
    env.step(2, P0);
    assert_eq!(env.cross("flow sells", &flow, g, 1, 1_000 * BASE, 91_300_000), BASE as i64);
    env.step(2, P0);
}

fn open_short(env: &mut Env, g: &Guarded) {
    let flow = env.trader("flow", 1_000_000);
    assert_ok(&env.gplace("agent ask", g, Order::resting(1, BASE, 91_500_000)));
    env.step(2, P0);
    assert_eq!(env.cross("flow buys", &flow, g, 0, 1_000 * BASE, 91_500_000), -(BASE as i64));
    env.step(2, P0);
}

fn tighten(env: &mut Env, g: &Guarded, l: &Limits) {
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_limits("owner sets limits", g, &owner, l));
}

// ------------------------------------------------------------------ F1 Oracle orders without an offset

#[test]
fn f1_oracle_order_without_offset_is_refused() {
    let (mut env, g) = setup(tight());
    let r = env.gplace("Oracle BUY, no offset, auction rel 0..0", &g, oracle_no_limit(0));
    assert_refused(&r, gerr::PRICE_OUTSIDE_BAND);
    assert!(raw_orders(&env, &g.owner.pubkey()).is_empty(), "nothing reached Velocity");
    let mut no_auction = oracle_no_limit(0);
    no_auction.auction = None;
    assert_refused(&env.gplace("Oracle BUY, no offset, no auction", &g, no_auction), gerr::PRICE_OUTSIDE_BAND);
    let mut zero = oracle_no_limit(0);
    zero.oracle_price_offset = Some(0);
    assert_refused(&env.gplace("Oracle BUY, offset 0", &g, zero), gerr::PRICE_OUTSIDE_BAND);
    let mut twin = oracle_no_limit(0);
    twin.oracle_price_offset = Some(500_000); // +0.50, in band
    let r = env.gplace("Oracle BUY, offset +0.50", &g, twin);
    assert_ok(&r);
    assert!(events(&r)[0].accepted);
}

#[test]
fn f1_oracle_order_without_offset_cannot_fill_far_from_the_oracle() {
    // The reviewer's attack A: a partner rests an ask 7% above the oracle; the no-offset Oracle BUY used to fill there.
    let (mut env, g) = setup(tight());
    let owner = g.owner.pubkey();
    let partner = env.trader("partner", 100_000);
    let keeper = env.trader("keeper", 1_000);
    assert_ok(&env.place("partner rests SELL 1 @ 97.80 (+7%)", &partner, Order::resting(1, BASE, 97_800_000)));
    env.step(1, P0);
    assert_refused(&env.gplace("attack: Oracle BUY, no offset", &g, oracle_no_limit(0)), gerr::PRICE_OUTSIDE_BAND);
    env.step(20, P0);
    let before = env.totals(&owner);
    let pp = partner.pubkey();
    let _ = env.fill_order("keeper tries to fill", &keeper, &owner, 1, &[&pp]);
    assert_eq!(env.totals(&owner), before, "no position was bought at +7%");
}

#[test]
fn f1_oracle_exit_without_offset_is_refused_even_while_paused() {
    let mut l = tight();
    l.allowed_order_types = T_LIMIT | T_ORACLE;
    let (mut env, g) = setup(l);
    open_long(&mut env, &g);
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_paused("owner pauses", &g, &owner, true));
    let mut e = oracle_no_limit(1);
    e.reduce_only = true;
    let r = env.gplace("exit: Oracle SELL, no offset, paused", &g, e);
    assert_refused(&r, gerr::PRICE_OUTSIDE_BAND);
    let mut twin = e;
    twin.oracle_price_offset = Some(-500_000);
    let r = env.gplace("exit: Oracle SELL, offset -0.50", &g, twin);
    assert_ok(&r);
    let ev = events(&r);
    assert!(ev[0].accepted && ev[0].rule == rule::G9);
}

#[test]
fn f1_stale_exit_oracle_without_offset_is_refused() {
    let mut l = tight();
    l.allowed_order_types = T_LIMIT | T_ORACLE;
    l.max_oracle_staleness_slots = 3;
    l.exit_max_staleness_slots = 10;
    let (mut env, g) = setup(l);
    open_short(&mut env, &g);
    env.step(1, P0);
    env.advance(50);
    let mut e = oracle_no_limit(0);
    e.reduce_only = true;
    assert_refused(&env.gplace("stale exit: Oracle BUY, no offset", &g, e), gerr::STALE_EXIT_UNFAVOURABLE);
    let mut twin = e;
    twin.oracle_price_offset = Some(-100_000); // buy at oracle - 0.10: owner-favourable
    twin.auction = Some((10, -200_000, -100_000));
    let r = env.gplace("stale exit: Oracle BUY, offset -0.10", &g, twin);
    assert_ok(&r);
    assert!(events(&r)[0].accepted);
}

// ------------------------------------------------------------------ F2 exits keep the order-type allowlist

#[test]
fn f2_exit_must_use_an_allowed_order_type() {
    let mut l = tight();
    l.allowed_order_types = T_LIMIT;
    let (mut env, g) = setup(l);
    open_long(&mut env, &g);
    let mut e = Order::limit(1, BASE, 0);
    e.order_type = 4;
    e.oracle_price_offset = Some(-500_000);
    e.reduce_only = true;
    assert_refused(&env.gplace("exit as an Oracle order when only Limit is allowed", &g, e), gerr::ORDER_TYPE_NOT_ALLOWED);
    let mut twin = Order::resting(1, BASE, 91_500_000);
    twin.reduce_only = true;
    let r = env.gplace("exit as a Limit order", &g, twin);
    assert_ok(&r);
    assert!(events(&r)[0].accepted);
}

// ------------------------------------------------------------------ F3 the agent cancels only orders the guard placed

#[test]
fn f3_agent_cannot_cancel_the_owners_orders_or_cancel_all() {
    let (mut env, g) = setup(tight());
    let owner_kp = g.owner.insecure_clone();
    let owner = owner_kp.pubkey();
    let mut a = Order::resting(0, BASE, 90_800_000);
    a.user_order_id = 7;
    assert_ok(&env.place("owner places BUY 1 directly", &owner_kp, a));
    let owner_ids: Vec<u32> = raw_orders(&env, &owner).iter().map(|o| o.order_id).collect();
    let before = env.guard_state(&g);
    let r = env.gcancel("agent cancels the owner's order by id", &g, Some(owner_ids[0]));
    assert_ok(&r);
    assert_eq!(raw_orders(&env, &owner).len(), 1, "the owner's order is still there");
    let r = env.gcancel("agent cancels with None (cancel-all)", &g, None);
    assert_ok(&r);
    assert_eq!(raw_orders(&env, &owner).len(), 1, "still there");
    let after = env.guard_state(&g);
    assert_eq!(after.refused_cancels, before.refused_cancels + 2, "both refusals are counted");
    // twin: an order the guard placed can be cancelled by id
    assert_ok(&env.gplace("agent places through the guard", &g, Order::resting(0, BASE, 90_700_000)));
    let id = env.last_guard_order(&g).expect("guard-placed order recorded");
    assert!(!owner_ids.contains(&id));
    assert_ok(&env.gcancel("agent cancels its own order", &g, Some(id)));
    assert!(!raw_orders(&env, &owner).iter().any(|o| o.order_id == id), "cancelled");
    assert_eq!(env.guard_state(&g).cancel_count, after.cancel_count + 1);
}

// ------------------------------------------------------------------ F4 stacked exits beyond the position

#[test]
fn f4_exits_beyond_the_position_counting_resting_exits_are_not_exits() {
    let (mut env, g) = setup(tight());
    open_long(&mut env, &g);
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_paused("owner pauses", &g, &owner, true));
    let mut half = Order::resting(1, BASE / 2, 91_500_000);
    half.reduce_only = true;
    let r = env.gplace("exit 0.5", &g, half);
    assert!(events(&r)[0].accepted);
    half.price = 91_510_000;
    let r = env.gplace("exit 0.5 more (total 1.0 = position)", &g, half);
    assert!(events(&r)[0].accepted, "two halves fit the position");
    half.price = 91_520_000;
    let r = env.gplace("exit 0.5 beyond the position", &g, half);
    assert_refused(&r, gerr::PAUSED); // not an exit any more, so the pause applies
}

// ------------------------------------------------------------------ INFO: order lifetime and per-rule last refusal

#[test]
fn info_order_lifetime_bound() {
    let mut l = tight();
    l.max_order_lifetime_secs = 60;
    let (mut env, g) = setup(l);
    let now = env.now();
    let mut o = Order::resting(0, BASE, 91_000_000);
    assert_refused(&env.gplace("no max_ts", &g, o), gerr::ORDER_LIFETIME_TOO_LONG);
    o.max_ts = Some(now + 120);
    assert_refused(&env.gplace("max_ts 120 s out", &g, o), gerr::ORDER_LIFETIME_TOO_LONG);
    o.max_ts = Some(now + 60);
    let r = env.gplace("max_ts 60 s out", &g, o);
    assert_ok(&r);
    assert!(events(&r)[0].accepted);
}

#[test]
fn info_last_refusal_is_also_kept_per_rule() {
    let (mut env, g) = setup(tight());
    let mut l = tight();
    l.max_order_base = BASE;
    tighten(&mut env, &g, &l);
    assert_refused(&env.gplace("G1 refusal", &g, Order::resting(0, 2 * BASE, 91_000_000)), gerr::ORDER_TOO_LARGE);
    assert_refused(&env.gplace("G6 refusal", &g, Order::resting(0, BASE / 2, 80_000_000)), gerr::PRICE_OUTSIDE_BAND);
    let st = env.guard_state(&g);
    assert_eq!(st.last_refusal.rule, rule::G6, "the latest refusal");
    assert_eq!(st.last_refusal_by_rule[rule::G1 as usize].reason, gerr::ORDER_TOO_LARGE, "the G1 refusal is not buried");
    assert_eq!(st.last_refusal_by_rule[rule::G6 as usize].reason, gerr::PRICE_OUTSIDE_BAND);
}


// ------------------------------------------------------------------ R5 (review of e328f57): max_ts and the placed-id buffer

/// What Velocity does with max_ts: 0 is stored as "no expiry" (so a guard that only bounds max_ts - now lets it through
/// with no lifetime at all); a past or negative max_ts makes Velocity skip the order.
#[test]
fn r5_velocity_stores_max_ts_zero_as_no_expiry_and_skips_a_past_one() {
    let (mut env, g) = setup(tight());
    let owner_kp = g.owner.insecure_clone();
    let owner = owner_kp.pubkey();
    let now = env.now();
    let mut o = Order::resting(0, BASE, 91_000_000);
    o.max_ts = Some(0);
    assert_ok(&env.place("owner: max_ts 0", &owner_kp, o));
    let stored = raw_orders(&env, &owner);
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].max_ts, 0, "stored with no expiry");
    // A past or negative max_ts: Velocity logs "skipping order" and stores nothing (the transaction succeeds).
    for (price, ts) in [(90_990_000, now - 10), (90_980_000, -5)] {
        o.price = price;
        o.max_ts = Some(ts);
        let r = env.place("owner: max_ts in the past", &owner_kp, o);
        assert_ok(&r);
        assert!(r.unwrap().logs.iter().any(|l| l.contains("skipping order")));
        assert_eq!(raw_orders(&env, &owner).len(), 1, "nothing new stored");
    }
}

#[test]
fn r5_lifetime_cap_refuses_zero_negative_and_past_max_ts() {
    let mut l = tight();
    l.max_order_lifetime_secs = 60;
    let (mut env, g) = setup(l);
    let now = env.now();
    let mut o = Order::resting(0, BASE, 91_000_000);
    for (label, ts) in [("max_ts 0 (never expires)", 0), ("negative max_ts", -5), ("max_ts now", now), ("max_ts 10 s ago", now - 10)] {
        o.max_ts = Some(ts);
        let ev = assert_refused(&env.gplace(label, &g, o), gerr::ORDER_LIFETIME_TOO_LONG);
        assert_eq!(ev.cap, 60);
        o.price -= 1_000;
    }
    // twin: 30 s out is inside the cap, and Velocity stores exactly that expiry
    o.max_ts = Some(now + 30);
    let r = env.gplace("max_ts 30 s out", &g, o);
    assert!(events(&r)[0].accepted);
    let id = env.last_guard_order(&g).unwrap();
    let stored = raw_orders(&env, &g.owner.pubkey()).into_iter().find(|x| x.order_id == id).unwrap();
    assert_eq!(stored.max_ts, now + 30);
}

#[test]
fn r5_an_open_guard_order_stays_cancellable_after_32_more_placements() {
    let (mut env, g) = setup(tight());
    assert_ok(&env.gplace("order A rests", &g, Order::resting(0, BASE / 10, 91_000_000)));
    let a = env.last_guard_order(&g).unwrap();
    for k in 0..32u64 {
        let r = env.gplace(&format!("order {k}"), &g, Order::resting(0, BASE / 10, 90_900_000 - k * 1_000));
        assert!(events(&r)[0].accepted);
        let id = env.last_guard_order(&g).unwrap();
        assert_ne!(id, a);
        assert_ok(&env.gcancel(&format!("cancel order {k}"), &g, Some(id)));
        assert!(!raw_orders(&env, &g.owner.pubkey()).iter().any(|o| o.order_id == id));
    }
    let before = env.guard_state(&g).cancel_count;
    assert_ok(&env.gcancel("agent cancels order A", &g, Some(a)));
    assert!(!raw_orders(&env, &g.owner.pubkey()).iter().any(|o| o.order_id == a), "order A is cancelled");
    assert_eq!(env.guard_state(&g).cancel_count, before + 1);
}

#[test]
fn r5_with_32_guard_orders_open_the_next_is_refused_not_evicting_a_live_id() {
    let (mut env, g) = setup(tight());
    let mut ids = vec![];
    for k in 0..32u64 {
        let r = env.gplace(&format!("order {k}"), &g, Order::resting(0, BASE / 100, 90_900_000 - k * 1_000));
        assert!(events(&r)[0].accepted, "order {k}");
        ids.push(env.last_guard_order(&g).unwrap());
    }
    let ev = assert_refused(&env.gplace("order 33", &g, Order::resting(0, BASE / 100, 90_500_000)), gerr::TOO_MANY_OPEN_ORDERS);
    assert_eq!((ev.value, ev.cap), (32, 32));
    for id in &ids {
        assert!(env.guard_state(&g).placed_order_ids.contains(id), "live id {id} kept");
    }
    // twin: cancel one, and the next order fits
    assert_ok(&env.gcancel("cancel the first", &g, Some(ids[0])));
    let r = env.gplace("order 33 again", &g, Order::resting(0, BASE / 100, 90_490_000));
    assert!(events(&r)[0].accepted);
    assert_ok(&env.gcancel("the oldest live one is still cancellable", &g, Some(ids[1])));
    assert!(!raw_orders(&env, &g.owner.pubkey()).iter().any(|o| o.order_id == ids[1]));
}

#[test]
fn r5_ids_the_owner_cancelled_directly_are_forgotten_so_new_orders_still_fit() {
    let (mut env, g) = setup(tight());
    for k in 0..32u64 {
        let r = env.gplace(&format!("order {k}"), &g, Order::resting(0, BASE / 100, 90_900_000 - k * 1_000));
        assert!(events(&r)[0].accepted, "order {k}");
    }
    let owner = g.owner.insecure_clone();
    assert_ok(&env.gcancel_raw(&owner)); // the owner cancels everything on Velocity, not through the guard
    assert!(raw_orders(&env, &owner.pubkey()).is_empty());
    let r = env.gplace("the agent's next order", &g, Order::resting(0, BASE / 100, 90_500_000));
    assert!(events(&r)[0].accepted, "stale ids were pruned, so the order fits");
    let st = env.guard_state(&g);
    assert_eq!(st.placed_order_ids.iter().filter(|x| **x != 0).count(), 1, "only the live id is remembered");
}

#[allow(dead_code)]
fn _unused(_: Keypair) {}
