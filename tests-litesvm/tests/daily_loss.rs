//! G10 daily-loss brake: the owner sets max_daily_loss (quote units). The first risk-increasing order of each UTC
//! day that reaches the check stores a baseline (equity = collateral + unrealized PnL, plus Velocity's net deposits
//! at that moment). A risk-increasing order is refused once baseline - equity, adjusted for deposits and withdrawals
//! since, exceeds the cap. Exits and cancels always pass. REPLAY on Velocity's real devnet binary; prices written by
//! the test.

use guardrail_tests::*;
use solana_signer::Signer;

const P0: u64 = 91_390_000;
const DAY_SLOTS: u64 = 216_000; // 86,400 s at 0.4 s a slot

fn price(pct_down: f64) -> u64 {
    (P0 as f64 * (1.0 - pct_down / 100.0)) as u64
}

/// A guard with 1,000 dUSDT, loose limits, a 5 SOL long opened at P0, and a 20 dUSDT daily loss cap.
fn setup() -> (Env, Guarded) {
    let mut env = Env::new();
    env.add_guard_program();
    env.step(1, P0);
    let g = env.guarded(1_000, Limits::loose());
    env.step(2, P0);
    let flow = env.trader("flow", 1_000_000);
    assert_ok(&env.gplace("agent bids 5 SOL", &g, Order::resting(0, 5 * BASE, P0)));
    env.step(2, P0);
    assert_eq!(env.cross("flow sells into the bid", &flow, &g, 1, 1_000 * BASE, P0), 5 * BASE as i64);
    env.step(2, P0);
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_daily_loss("owner sets a 20 dUSDT daily loss cap", &g, &owner, 20 * QUOTE));
    (env, g)
}

/// A small bid just under the oracle (risk-increasing).
fn bid(env: &mut Env, g: &Guarded, label: &str, px: u64) -> TxResult {
    env.gplace(label, g, Order::resting(0, BASE / 10, px - 10_000))
}

/// The first risk-increasing order of the day stores the baseline.
fn start_day(env: &mut Env, g: &Guarded) {
    let r = bid(env, g, "first bid of the day (baseline)", P0);
    assert!(events(&r)[0].accepted);
    assert!(env.guard_state(g).baseline_equity > 0, "baseline stored");
}

#[test]
fn g10_refuses_risk_increasing_orders_once_the_days_loss_passes_the_cap() {
    let (mut env, g) = setup();
    start_day(&mut env, &g);
    // 5% down on 5.1 SOL is about 23 dUSDT lost, over the 20 cap
    env.step(5, price(5.0));
    let ev = assert_refused(&bid(&mut env, &g, "bid after a 5% drop", price(5.0)), gerr::DAILY_LOSS_EXCEEDED);
    assert_eq!(ev.rule, rule::G10);
    assert_eq!(ev.cap, 20 * QUOTE as i128);
    assert!(ev.value > 20 * QUOTE as i128 && ev.value < 26 * QUOTE as i128, "loss measured: {}", ev.value);
    let st = env.guard_state(&g);
    assert_eq!(st.refused_g10, 1, "counted under G10");
    assert_eq!(st.refused[7], 0, "not filed under G7");
    assert_eq!(st.last_refusal_g10.reason, gerr::DAILY_LOSS_EXCEEDED);
    assert_eq!(st.last_refusal.rule, rule::G10);
}

#[test]
fn g10_twin_a_loss_under_the_cap_is_accepted() {
    let (mut env, g) = setup();
    start_day(&mut env, &g);
    env.step(5, price(3.0)); // about 14 dUSDT
    assert!(events(&bid(&mut env, &g, "bid after a 3% drop", price(3.0)))[0].accepted);
}

#[test]
fn g10_baseline_does_not_move_across_refused_calls() {
    let (mut env, g) = setup();
    start_day(&mut env, &g);
    let base = env.guard_state(&g).baseline_equity;
    env.step(5, price(5.0));
    assert_refused(&bid(&mut env, &g, "refused once", price(5.0)), gerr::DAILY_LOSS_EXCEEDED);
    env.step(1, price(5.0));
    assert_refused(&bid(&mut env, &g, "refused again", price(5.0) - 1_000), gerr::DAILY_LOSS_EXCEEDED);
    assert_eq!(env.guard_state(&g).baseline_equity, base, "the baseline stays for the whole day");
}

#[test]
fn g10_an_exit_and_a_cancel_pass_at_the_cap() {
    let (mut env, g) = setup();
    start_day(&mut env, &g);
    let id = env.last_guard_order(&g).unwrap();
    env.step(5, price(5.0));
    assert_refused(&bid(&mut env, &g, "bid refused", price(5.0)), gerr::DAILY_LOSS_EXCEEDED);
    let mut exit = Order::resting(1, BASE, price(5.0) + 10_000);
    exit.reduce_only = true;
    let r = env.gplace("exit 1 SOL at the cap", &g, exit);
    assert!(events(&r)[0].accepted, "exits always pass");
    assert_ok(&env.gcancel("cancel the resting bid", &g, Some(id)));
    assert!(!raw_orders(&env, &g.owner.pubkey()).iter().any(|o| o.order_id == id));
}

#[test]
fn g10_a_new_utc_day_resets_the_baseline() {
    let (mut env, g) = setup();
    start_day(&mut env, &g);
    let day0 = env.guard_state(&g).loss_day;
    env.step(5, price(5.0));
    assert_refused(&bid(&mut env, &g, "refused today", price(5.0)), gerr::DAILY_LOSS_EXCEEDED);
    env.step(DAY_SLOTS, price(5.0));
    let r = bid(&mut env, &g, "first bid of the next day", price(5.0));
    assert!(events(&r)[0].accepted, "new day, new baseline");
    assert_eq!(env.guard_state(&g).loss_day, day0 + 1);
}

#[test]
fn g10_a_mid_day_deposit_does_not_hide_a_loss() {
    let (mut env, g) = setup();
    start_day(&mut env, &g);
    env.step(5, price(5.0));
    let owner = g.owner.insecure_clone();
    assert_ok(&env.deposit_more("owner deposits 500 mid-day", &owner, 500));
    assert_refused(&bid(&mut env, &g, "bid after the deposit", price(5.0)), gerr::DAILY_LOSS_EXCEEDED);
}

#[test]
fn g10_a_mid_day_withdrawal_is_not_a_loss() {
    let (mut env, g) = setup();
    start_day(&mut env, &g);
    let owner = g.owner.insecure_clone();
    env.step(2, P0);
    assert_ok(&env.withdraw("owner withdraws 100 mid-day", &owner, 100));
    assert!(events(&bid(&mut env, &g, "bid after the withdrawal", P0))[0].accepted);
}

#[test]
fn g10_cap_zero_is_off() {
    let (mut env, g) = setup();
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_daily_loss("owner turns the brake off", &g, &owner, 0));
    assert!(events(&bid(&mut env, &g, "first bid of the day", P0))[0].accepted);
    assert_eq!(env.guard_state(&g).baseline_equity, 0, "no baseline while the brake is off");
    env.step(5, price(8.0));
    assert!(events(&bid(&mut env, &g, "bid after an 8% drop, brake off", price(8.0)))[0].accepted);
}

#[test]
fn g10_only_the_owner_sets_the_cap() {
    let (mut env, g) = setup();
    let agent = g.agent.insecure_clone();
    assert!(env.set_daily_loss("agent tries to lift the cap", &g, &agent, u64::MAX).is_err());
    assert_eq!(env.guard_state(&g).max_daily_loss, 20 * QUOTE);
}

#[test]
fn an_order_velocity_does_not_store_fails_instead_of_counting_as_accepted() {
    let (mut env, g) = setup();
    let before = env.guard_state(&g);
    let mut o = Order::resting(0, BASE / 10, P0 - 20_000);
    o.max_ts = Some(env.now() - 10); // no lifetime cap set; Velocity skips this order
    let r = env.gplace("past max_ts, no lifetime cap", &g, o);
    assert!(r.is_err(), "the transaction fails");
    let after = env.guard_state(&g);
    assert_eq!(after.accepted_count, before.accepted_count);
    assert_eq!(after.day_notional, before.day_notional);
}

#[test]
fn g10_an_exit_first_day_starts_the_count_at_that_exit() {
    let (mut env, g) = setup();
    env.step(DAY_SLOTS, P0); // a new UTC day; no baseline yet
    let mut exit = Order::resting(1, BASE, P0 + 20_000);
    exit.reduce_only = true;
    assert!(events(&env.gplace("the day's first call is an exit", &g, exit))[0].accepted);
    assert!(env.guard_state(&g).baseline_equity > 0, "the exit took the day's baseline");
    env.step(5, price(5.0));
    assert_refused(&bid(&mut env, &g, "a risky bid after a 5% drop", price(5.0)), gerr::DAILY_LOSS_EXCEEDED);
}

#[test]
fn g10_a_cancel_first_day_starts_the_count_at_that_cancel() {
    let (mut env, g) = setup();
    assert!(events(&bid(&mut env, &g, "a resting bid from yesterday", P0))[0].accepted);
    let id = env.last_guard_order(&g).unwrap();
    env.step(DAY_SLOTS, P0);
    assert_ok(&env.gcancel("the day's first call is a cancel", &g, Some(id)));
    assert!(env.guard_state(&g).loss_day > 0 && env.guard_state(&g).baseline_equity > 0, "the cancel took the day's baseline");
    env.step(5, price(5.0));
    assert_refused(&bid(&mut env, &g, "a risky bid after a 5% drop", price(5.0)), gerr::DAILY_LOSS_EXCEEDED);
}
