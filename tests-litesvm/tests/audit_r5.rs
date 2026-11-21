//! Audit round 5 and the final review panel (Nov 22): keeper is never the agent, the stored baseline carried when the
//! day high is absent, the owner's reset at any time, and no carry across a gap of more than one day.
//! REPLAY on Velocity's real devnet binary; prices written by the test.

use guardrail_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const P0: u64 = 91_390_000;

fn small_bid(px: u64) -> Order {
    Order::resting(0, BASE / 10, px - 10_000)
}

fn secs_to(env: &Env, hh: i64, mm: i64) -> u64 {
    let now = env.now().rem_euclid(86_400);
    let target = hh * 3600 + mm * 60;
    let d = if target > now { target - now } else { 86_400 - now + target };
    (d * 5 / 2) as u64
}

/// 1,000 dUSDT, long 5 SOL, the owner's key as keeper, cap 20 dUSDT.
fn g10_setup() -> (Env, Guarded) {
    let mut env = Env::new();
    env.add_guard_program();
    env.step(1, P0);
    let g = env.guarded(1_000, Limits::loose());
    env.step(2, P0);
    let flow = env.trader("flow", 1_000_000);
    assert_ok(&env.gplace("agent bids 5 SOL", &g, Order::resting(0, 5 * BASE, P0)));
    env.step(2, P0);
    env.cross("flow sells", &flow, &g, 1, 1_000 * BASE, P0);
    env.step(2, P0);
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_daily_loss("keeper (the owner) and cap 20", &g, &owner, 20 * QUOTE));
    (env, g)
}

// ---------------------------------------------------------------- the keeper is never the agent

#[test]
fn r5_the_keeper_cannot_be_the_agent() {
    let (mut env, g) = g10_setup();
    let owner = g.owner.insecure_clone();
    let agent = g.agent.pubkey();
    assert_refused_tx(&env.set_keeper("keeper = the agent", &g, &owner, &agent), gerr::KEEPER_IS_AGENT);
    let other = Keypair::new();
    assert_ok(&env.set_keeper("keeper = another key", &g, &owner, &other.pubkey()));
    assert_refused_tx(&env.set_agent("agent = the keeper", &g, &owner, &other.pubkey()), gerr::KEEPER_IS_AGENT);
}

// ---------------------------------------------------------------- the upgrade night: no day high, the stored baseline counts

#[test]
fn r5_with_no_day_high_the_stored_days_baseline_still_counts() {
    let (mut env, g) = g10_setup();
    assert!(events(&env.gplace("morning: the day's baseline", &g, small_bid(P0)))[0].accepted);
    let dip = (P0 as f64 * 0.95) as u64;
    env.step(secs_to(&env, 22, 59), dip);
    assert_ok(&env.gcancel("22:59: the old binary sees the dip", &g, Some(999_999)));
    env.clear_day_high(&g); // upgraded at 23:30 from a binary that kept no day high; no call before midnight
    env.step(secs_to(&env, 0, 1), P0);
    env.step(secs_to(&env, 2, 0), dip);
    assert_refused(&env.gplace("02:00: a bid at the dip", &g, small_bid(dip)), gerr::DAILY_LOSS_EXCEEDED);
}

// ---------------------------------------------------------------- the owner resets the baseline at any time

#[test]
fn r5_the_owner_resets_the_baseline_at_any_time() {
    let (mut env, g) = g10_setup();
    assert!(events(&env.gplace("the day's baseline", &g, small_bid(P0)))[0].accepted);
    let low = (P0 as f64 * 0.95) as u64;
    env.step(5, low);
    assert_refused(&env.gplace("a bid after a 5% drop", &g, small_bid(low)), gerr::DAILY_LOSS_EXCEEDED);
    env.step(secs_to(&env, 10, 0), low); // mid-morning, long after the first hour
    let agent = g.agent.insecure_clone();
    assert_ok(&env.checkpoint_as("the agent's checkpoint changes nothing", &g, &agent));
    assert_refused(&env.gplace("still refused", &g, small_bid(low)), gerr::DAILY_LOSS_EXCEEDED);
    let owner = g.owner.insecure_clone();
    let r = env.checkpoint_as("the owner resets the baseline", &g, &owner);
    assert_ok(&r);
    assert!(r.unwrap().logs.iter().any(|l| l.contains("Program data:")), "the reset emits an event");
    assert!(events(&env.gplace("a bid after the owner's reset", &g, small_bid(low - 1_000)))[0].accepted);
}

// ---------------------------------------------------------------- no carry across a gap of more than one day

#[test]
fn r5_after_a_gap_of_more_than_a_day_the_baseline_is_equity_now() {
    let (mut env, g) = g10_setup();
    assert!(events(&env.gplace("day 1: a call at the high", &g, small_bid(P0)))[0].accepted);
    let low = (P0 as f64 * 0.95) as u64;
    env.step(2 * 216_000, low); // two full days with no guard call
    assert!(events(&env.gplace("day 3: the first call, a bid at the low", &g, small_bid(low)))[0].accepted, "no carry after a gap");
}

#[test]
fn r5_twin_the_carry_holds_from_the_previous_day() {
    let (mut env, g) = g10_setup();
    assert!(events(&env.gplace("day 1: a call at the high", &g, small_bid(P0)))[0].accepted);
    let low = (P0 as f64 * 0.95) as u64;
    env.step(secs_to(&env, 2, 0), low); // the next day, 02:00, no mark
    assert_refused(&env.gplace("day 2: a bid at the low", &g, small_bid(low)), gerr::DAILY_LOSS_EXCEEDED);
}
