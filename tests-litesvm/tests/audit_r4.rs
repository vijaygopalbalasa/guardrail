//! Audit round 4 (Nov 21): migration only from known layouts, the previous day's high carried when the keeper misses,
//! and the keeper requirement kept. REPLAY on Velocity's real devnet binary; prices written by the test.

use guardrail_tests::*;

const P0: u64 = 91_390_000;

fn setup() -> (Env, Guarded) {
    let mut env = Env::new();
    env.add_guard_program();
    env.step(1, P0);
    let g = env.guarded(1_000, Limits::loose());
    env.step(2, P0);
    (env, g)
}

fn small_bid(px: u64) -> Order {
    Order::resting(0, BASE / 10, px - 10_000)
}

fn secs_to(env: &Env, hh: i64, mm: i64) -> u64 {
    let now = env.now().rem_euclid(86_400);
    let target = hh * 3600 + mm * 60;
    let d = if target > now { target - now } else { 86_400 - now + target };
    (d * 5 / 2) as u64
}

// ---------------------------------------------------------------- 1: migration only from known append-only layouts

#[test]
fn r4_1_a_guard_older_than_the_append_only_layouts_cannot_migrate_but_can_close() {
    let (mut env, g) = setup();
    let owner = g.owner.insecure_clone();
    env.truncate_guard(&g, 352); // the round-1 layout: not a prefix (Limits grew in the middle)
    assert_refused_tx(&env.migrate_guard("migrate a 352-byte guard", &g, &owner), gerr::BAD_GUARD_ACCOUNT);
    assert_ok(&env.close_guard("close it instead", &g, &owner));
    assert_ok(&env.init_guard_again("and create it again", &g, &Limits::loose()));
}

// ---------------------------------------------------------------- 2: the previous day's high when the keeper misses

/// Long 5, cap 20, a keeper named but not running. Day 1: a call at the high. Then the agent observes at a 5% dip
/// (at `dip_at` on `dip_day` days later), the price recovers by midnight, and at 02:00 it dips 5% again and the
/// agent bids.
fn keeper_misses(dip_day: u64, dip_at: (i64, i64)) -> TxResult {
    keeper_misses_with(dip_day, dip_at, false)
}

fn keeper_misses_with(dip_day: u64, dip_at: (i64, i64), no_day_high: bool) -> TxResult {
    let (mut env, g) = setup();
    let flow = env.trader("flow", 1_000_000);
    assert_ok(&env.gplace("agent bids 5 SOL", &g, Order::resting(0, 5 * BASE, P0)));
    env.step(2, P0);
    env.cross("flow sells", &flow, &g, 1, 1_000 * BASE, P0);
    env.step(2, P0);
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_daily_loss("keeper named (it will not run) and cap 20", &g, &owner, 20 * QUOTE));
    assert!(events(&env.gplace("day 1: a call at the high", &g, small_bid(P0)))[0].accepted);
    if no_day_high {
        env.clear_day_high(&g); // a guard from before the day-high fields: only the last equity seen is carried
    }
    let dip = (P0 as f64 * 0.95) as u64;
    env.step(dip_day * 216_000, P0);
    env.step(secs_to(&env, dip_at.0, dip_at.1), dip);
    assert_ok(&env.gcancel("the agent observes at the dip with a refused cancel", &g, Some(999_999)));
    env.step(secs_to(&env, 0, 1), P0); // just after midnight, recovered, no keeper mark
    env.step(secs_to(&env, 2, 0), dip); // 02:00, down 5% again
    env.gplace("02:00: the agent's first bid of the day", &g, small_bid(dip))
}

#[test]
fn r4_2_a_dip_at_2259_does_not_lower_the_next_days_baseline() {
    assert_refused(&keeper_misses(0, (22, 59)), gerr::DAILY_LOSS_EXCEEDED);
}

#[test]
fn r4_2_a_dip_at_2359_as_the_first_call_of_that_day_does_not_lower_the_baseline() {
    assert_refused(&keeper_misses(1, (23, 59)), gerr::DAILY_LOSS_EXCEEDED);
}

// ---------------------------------------------------------------- 4: no cap without a keeper

#[test]
fn r4_4_the_keeper_cannot_be_removed_while_a_cap_is_set() {
    let (mut env, g) = setup();
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_daily_loss("keeper and cap 20", &g, &owner, 20 * QUOTE));
    assert_refused_tx(&env.set_keeper("remove the keeper with the cap on", &g, &owner, &Pubkey::default()), gerr::KEEPER_REQUIRED);
    assert_ok(&env.set_daily_loss_only("turn the cap off", &g, &owner, 0));
    assert_ok(&env.set_keeper("then the keeper can go", &g, &owner, &Pubkey::default()));
}

#[test]
fn r4_2_a_guard_without_a_day_high_still_carries_the_last_equity_seen() {
    // A guard from before the day-high fields: day 1 is seen only at the high; the next day the first call is a bid at a
    // 5% dip. The carried last equity seen (the high) keeps the baseline up, so the bid is refused.
    let (mut env, g) = setup();
    let flow = env.trader("flow", 1_000_000);
    assert_ok(&env.gplace("agent bids 5 SOL", &g, Order::resting(0, 5 * BASE, P0)));
    env.step(2, P0);
    env.cross("flow sells", &flow, &g, 1, 1_000 * BASE, P0);
    env.step(2, P0);
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_daily_loss("keeper named and cap 20", &g, &owner, 20 * QUOTE));
    assert!(events(&env.gplace("day 1: a call at the high", &g, small_bid(P0)))[0].accepted);
    env.clear_day_high(&g);
    let dip = (P0 as f64 * 0.95) as u64;
    env.step(secs_to(&env, 2, 0), dip);
    assert_refused(&env.gplace("next day 02:00: a bid at the dip", &g, small_bid(dip)), gerr::DAILY_LOSS_EXCEEDED);
}

// ---------------------------------------------------------------- review of day_high: a guard upgraded mid-day

/// Day 1: the long is opened and the baseline taken 2% under the later high; the price then rises to the high and the
/// guard sees it; then the guard is upgraded (no day-high fields yet). At 23:30 the agent observes at a dip (5% under
/// the high); the keeper misses midnight; at 02:00 the agent bids at the same dip. The high seen before the upgrade must
/// still count.
#[test]
fn r4_2b_a_guard_upgraded_mid_day_keeps_the_high_it_saw_before() {
    let mut env = Env::new();
    env.add_guard_program();
    let low1 = (P0 as f64 * 0.98) as u64 / 10 * 10;
    env.step(1, low1);
    let g = env.guarded(1_000, Limits::loose());
    env.step(2, low1);
    let flow = env.trader("flow", 1_000_000);
    assert_ok(&env.gplace("agent bids 5 SOL", &g, Order::resting(0, 5 * BASE, low1)));
    env.step(2, low1);
    env.cross("flow sells", &flow, &g, 1, 1_000 * BASE, low1);
    env.step(2, low1);
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_daily_loss("keeper named (it will not run) and cap 20", &g, &owner, 20 * QUOTE));
    assert!(events(&env.gplace("day 1: the baseline", &g, small_bid(low1)))[0].accepted);
    env.step(5, P0);
    assert!(events(&env.gplace("day 1: a call at the high (2% up)", &g, small_bid(P0)))[0].accepted);
    env.clear_day_high(&g); // the upgrade: no day-high fields yet
    let dip = (P0 as f64 * 0.95) as u64;
    env.step(secs_to(&env, 23, 30), dip);
    assert_ok(&env.gcancel("23:30: the agent observes at the dip", &g, Some(999_999)));
    env.step(secs_to(&env, 0, 1), P0);
    env.step(secs_to(&env, 2, 0), dip);
    assert_refused(&env.gplace("02:00: a bid at the dip", &g, small_bid(dip)), gerr::DAILY_LOSS_EXCEEDED);
}
