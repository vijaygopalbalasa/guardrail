//! Audit round 2 (Nov 21): the reviewer's probes on Velocity's real binary, ported as red-first tests with twins.
//! REPLAY: prices written by the test.

use guardrail_tests::*;
use solana_instruction::AccountMeta;
use solana_signer::Signer;

const P0: u64 = 91_390_000;
const DAY_SLOTS: u64 = 216_000;

fn setup_with(dusdt: u64, l: Limits) -> (Env, Guarded) {
    let mut env = Env::new();
    env.add_guard_program();
    env.step(1, P0);
    let g = env.guarded(dusdt, l);
    env.step(2, P0);
    (env, g)
}

fn open(env: &mut Env, g: &Guarded, dir: u8, size: u64) {
    let flow = env.trader("flow", 1_000_000);
    let px = if dir == 0 { 91_300_000 } else { 91_500_000 };
    assert_ok(&env.gplace("agent opens", g, Order::resting(dir, size, px)));
    env.step(2, P0);
    assert_eq!(env.cross("flow crosses", &flow, g, 1 - dir, 1_000 * BASE, px).unsigned_abs(), size);
    env.step(2, P0);
}

/// 1,000 dUSDT, long 5 SOL, G10 cap 20 dUSDT.
fn g10_setup() -> (Env, Guarded) {
    let (mut env, g) = setup_with(1_000, Limits::loose());
    open(&mut env, &g, 0, 5 * BASE);
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_daily_loss("cap 20", &g, &owner, 20 * QUOTE));
    (env, g)
}

fn small_bid(px: u64) -> Order {
    Order::resting(0, BASE / 10, px - 10_000)
}

// ---------------------------------------------------------------- N1 (and N5): no flip past flat with G10 tripped

#[test]
fn n1_two_plain_sells_cannot_flip_a_long_past_flat_with_g10_tripped() {
    let (mut env, g) = g10_setup();
    let owner = g.owner.pubkey();
    let ok = g.owner.insecure_clone();
    let mut l = Limits::loose();
    l.max_order_base = 5 * BASE;
    l.max_leverage_bps = 4_000; // 0.4x: the 5 SOL long (about 0.46x) is already over the cap
    assert_ok(&env.set_limits("owner: G1 5 SOL, G5 0.4x", &g, &ok, &l));
    assert_ok(&env.gplace("first call of the day (refused by G5, takes the baseline)", &g, small_bid(P0)));
    assert!(env.guard_state(&g).baseline_equity > 0);
    let p1 = (P0 as f64 * 0.95) as u64;
    env.step(5, p1);
    assert_refused(&env.gplace("a risky bid after a 5% drop", &g, small_bid(p1)), gerr::DAILY_LOSS_EXCEEDED);
    let _ = env.gcancel_raw(&ok);
    let px = p1 + 50_000;
    let mut o = Order::resting(1, 5 * BASE, px);
    o.user_order_id = 1;
    assert!(events(&env.gplace("plain SELL 5 #1 (a true exit)", &g, o))[0].accepted);
    o.user_order_id = 2;
    assert_refused(&env.gplace("plain SELL 5 #2 (would flip to short 5)", &g, o), gerr::DAILY_LOSS_EXCEEDED);
    let flow = env.trader("flow2", 1_000_000);
    env.step(2, p1);
    env.cross("flow takes the sells", &flow, &g, 0, 1_000 * BASE, px);
    assert_eq!(env.totals(&owner).0, 0, "flat, never short");
}

#[test]
fn n5_surplus_reduce_only_orders_are_refused_unpaused() {
    let (mut env, g) = setup_with(10_000, Limits::loose());
    open(&mut env, &g, 0, BASE);
    let mut exit = Order::resting(1, BASE, 91_500_000);
    exit.reduce_only = true;
    assert!(events(&env.gplace("reduce-only SELL 1 (the whole position)", &g, exit))[0].accepted);
    exit.price = 91_510_000;
    assert_refused(&env.gplace("a 2nd reduce-only SELL 1", &g, exit), gerr::REDUCE_ONLY_BEYOND_POSITION);
    exit.price = 91_520_000;
    assert_refused(&env.gplace("a 3rd reduce-only SELL 1", &g, exit), gerr::REDUCE_ONLY_BEYOND_POSITION);
}

// ---------------------------------------------------------------- N2: the agent cannot pick its baseline by waiting

#[test]
fn n2_waiting_for_the_low_does_not_reset_the_baseline() {
    let (mut env, g) = g10_setup();
    assert!(events(&env.gplace("a call on day 1 (the guard sees the equity)", &g, small_bid(P0)))[0].accepted);
    env.step(DAY_SLOTS, P0);
    let p_low = (P0 as f64 * 0.95) as u64;
    env.step(5, p_low);
    let ev = assert_refused(&env.gplace("day 2: first call only after a 5% drop", &g, small_bid(p_low)), gerr::DAILY_LOSS_EXCEEDED);
    assert!(ev.value > 20 * QUOTE as i128, "the overnight loss counts: {}", ev.value);
}

#[test]
fn n2_twin_no_drop_no_refusal_on_a_new_day() {
    let (mut env, g) = g10_setup();
    assert!(events(&env.gplace("a call on day 1", &g, small_bid(P0)))[0].accepted);
    env.step(DAY_SLOTS, P0);
    assert!(events(&env.gplace("day 2 at the same price", &g, small_bid(P0 - 1_000)))[0].accepted);
}

#[test]
fn n2_anyone_can_checkpoint_the_day_and_a_checkpoint_at_the_low_cannot_lower_it() {
    let (mut env, g) = g10_setup();
    env.step(DAY_SLOTS, P0);
    assert_ok(&env.checkpoint("a keeper (neither owner nor agent) checkpoints at the open", &g));
    let st = env.guard_state(&g);
    assert_eq!(st.loss_day, (env.now()).div_euclid(86_400));
    let base = st.baseline_equity;
    let p_low = (P0 as f64 * 0.95) as u64;
    env.step(5, p_low);
    assert_ok(&env.checkpoint("another checkpoint at the low", &g));
    assert_eq!(env.guard_state(&g).baseline_equity, base, "the day's baseline does not move");
    assert_refused(&env.gplace("a bid at the low", &g, small_bid(p_low)), gerr::DAILY_LOSS_EXCEEDED);
}

// ---------------------------------------------------------------- N3: exits obey the order lifetime

#[test]
fn n3_an_exit_without_max_ts_is_refused_when_a_lifetime_is_set() {
    let mut l = Limits::loose();
    l.price_band_bps = 100;
    l.max_order_lifetime_secs = 60;
    let (mut env, g) = setup_with(10_000, l);
    let flow = env.trader("flow", 1_000_000);
    let mut bid = Order::resting(0, BASE, 91_300_000);
    bid.max_ts = Some(env.now() + 30);
    assert_ok(&env.gplace("bid with max_ts", &g, bid));
    env.step(2, P0);
    env.cross("flow sells", &flow, &g, 1, 1_000 * BASE, 91_300_000);
    env.step(2, P0);
    let mut exit = Order::resting(1, BASE, 92_000_000);
    exit.reduce_only = true;
    assert_refused(&env.gplace("exit SELL @ 92.00 with no max_ts", &g, exit), gerr::ORDER_LIFETIME_TOO_LONG);
    exit.max_ts = Some(env.now() + 30);
    let r = env.gplace("the same exit with max_ts 30 s out", &g, exit);
    assert!(events(&r)[0].accepted);
    let stored = raw_orders(&env, &g.owner.pubkey()).into_iter().find(|o| o.reduce_only).unwrap();
    assert_eq!(stored.max_ts, env.now() + 30);
}

// ---------------------------------------------------------------- N4: the owner's reduce-only orders do not use the agent's exits

#[test]
fn n4_owner_reduce_only_orders_do_not_trap_the_agents_exit_while_paused() {
    let (mut env, g) = setup_with(10_000, Limits::loose());
    open(&mut env, &g, 0, 2 * BASE);
    let ok = g.owner.insecure_clone();
    let mut tp = Order::resting(1, 2 * BASE, 92_500_000);
    tp.reduce_only = true;
    tp.user_order_id = 9;
    assert_ok(&env.place("owner rests a reduce-only take-profit for the whole position", &ok, tp));
    assert_ok(&env.set_paused("owner pauses", &g, &ok, true));
    let mut exit = Order::resting(1, 2 * BASE, 91_500_000);
    exit.reduce_only = true;
    let r = env.gplace("agent exits the whole position while paused", &g, exit);
    assert!(events(&r)[0].accepted, "G9 counts only the guard's own resting exits");
    exit.price = 91_510_000;
    assert_refused(&env.gplace("a second full exit is beyond the position", &g, exit), gerr::PAUSED);
}

#[test]
fn n2_checkpoint_only_reads_the_guards_own_velocity_account() {
    let (mut env, g) = g10_setup();
    let other = env.trader("someone else", 50_000);
    let r = env.checkpoint_with_user("checkpoint with another Velocity account", &g, &user_pda(&other.pubkey()));
    assert!(r.is_err(), "has_one = velocity_user");
    env.step(DAY_SLOTS, P0);
    assert_ok(&env.checkpoint("the guard's own account", &g));
}

// ---------------------------------------------------------------- N2 review: the caller cannot choose what is observed

fn without(drop: Pubkey) -> Vec<AccountMeta> {
    Env::maps().into_iter().filter(|a| a.pubkey != drop).collect()
}

#[test]
fn n2b_a_cancel_without_an_oracle_account_is_refused() {
    let (mut env, g) = g10_setup();
    assert!(events(&env.gplace("a resting bid", &g, small_bid(P0)))[0].accepted);
    let id = env.last_guard_order(&g).unwrap();
    assert!(env.gcancel_with("cancel with the SOL oracle left out", &g, id, &without(SOL_ORACLE)).is_err());
    assert!(env.gcancel_with("cancel with SOL-PERP left out", &g, id, &without(PERP0)).is_err());
    assert!(env.gcancel_with("cancel with spot market 0 left out", &g, id, &without(SPOT0)).is_err());
    // a cancel the guard refuses never reaches Velocity, so only the guard can insist on the accounts
    for (label, drop) in [("refused cancel, no SOL oracle", SOL_ORACLE), ("refused cancel, no SOL-PERP", PERP0), ("refused cancel, no spot market", SPOT0)] {
        assert!(env.gcancel_with(label, &g, 999_999, &without(drop)).is_err(), "{label}");
    }
    // twin: with every account the cancel goes through (cancels stay always available)
    assert_ok(&env.gcancel("cancel with the full account set", &g, Some(id)));
}

#[test]
fn n2b_no_account_choice_lowers_the_next_days_baseline() {
    let (mut env, g) = g10_setup();
    assert!(events(&env.gplace("day 1: a complete call at the high", &g, small_bid(P0)))[0].accepted);
    let id = env.last_guard_order(&g).unwrap();
    let high = env.guard_state(&g).last_seen_equity;
    let p_low = (P0 as f64 * 0.95) as u64;
    env.step(5, p_low);
    // the agent tries to make the guard record only the low, or nothing at the high
    for (label, acc) in [("no SOL oracle", without(SOL_ORACLE)), ("no SOL-PERP", without(PERP0)), ("no spot market", without(SPOT0))] {
        assert!(env.gcancel_with(label, &g, id, &acc).is_err(), "{label}");
        assert!(env.gcancel_with(label, &g, 999_999, &acc).is_err(), "{label}: a refused cancel too");
        let mut o = small_bid(p_low);
        o.price -= 1_000;
        assert!(env.gplace_as(label, &g, &g.agent.insecure_clone(), o, &acc).is_err(), "{label}");
    }
    assert_eq!(env.guard_state(&g).last_seen_equity, high, "nothing but a complete call is recorded");
    env.step(DAY_SLOTS, p_low);
    assert_refused(&env.gplace("day 2 at the low", &g, small_bid(p_low)), gerr::DAILY_LOSS_EXCEEDED);
}

#[test]
fn n2b_a_checkpoint_in_the_first_hour_marks_the_day_at_midnight() {
    let p_low = (P0 as f64 * 0.95) as u64;
    for (label, extra_secs, expect_refused) in [("checkpoint at 00:10 UTC", 600i64, false), ("checkpoint at 03:00 UTC", 3 * 3600, true)] {
        let (mut env, g) = g10_setup();
        assert!(events(&env.gplace("day 1: a call at the high", &g, small_bid(P0)))[0].accepted);
        env.step(5, p_low); // the loss happens on day 1
        let now = env.now();
        let to_midnight = 86_400 - now.rem_euclid(86_400);
        env.step(((to_midnight + extra_secs) * 5 / 2) as u64, p_low);
        assert_ok(&env.checkpoint(label, &g));
        let r = env.gplace("day 2: a bid at the same low", &g, small_bid(p_low));
        if expect_refused {
            assert_refused(&r, gerr::DAILY_LOSS_EXCEEDED);
        } else {
            assert!(events(&r)[0].accepted, "{label}: yesterday's loss stays yesterday's");
        }
    }
}
