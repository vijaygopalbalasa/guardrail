//! Audit round 3 (Nov 21): guards made under an older layout, closing a guard, and the keeper as part of G10.
//! REPLAY on Velocity's real devnet binary; prices written by the test.

use guardrail_tests::*;
use solana_signer::Signer;

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

// ---------------------------------------------------------------- R3-1: older guards migrate; a guard can close

/// Guard sizes the devnet guards were made with: before G10, with G10, with last_seen, with the keeper.
const OLD_SIZES: [usize; 4] = [865, 950, 967, 999];

#[test]
fn r3_1_a_guard_made_under_an_older_layout_migrates_and_trades() {
    for len in OLD_SIZES {
        let (mut env, g) = setup();
        let owner = g.owner.insecure_clone();
        let mut l = Limits::loose();
        l.max_order_base = 3 * BASE;
        assert_ok(&env.set_limits("owner sets limits", &g, &owner, &l));
        assert!(events(&env.gplace("an order before the upgrade", &g, small_bid(P0)))[0].accepted);
        let before = env.guard_state(&g);
        env.truncate_guard(&g, len);
        assert!(env.gcancel("old layout: the agent's cancel", &g, Some(999_999)).is_err(), "{len}: an older guard does not load");
        let rent_before = env.svm.get_balance(&owner.pubkey()).unwrap();
        assert_ok(&env.migrate_guard("owner migrates the guard", &g, &owner));
        assert!(env.svm.get_balance(&owner.pubkey()).unwrap() < rent_before, "the owner pays the extra rent");
        let after = env.guard_state(&g);
        assert_eq!(after.accepted_count, before.accepted_count, "{len}: counters kept");
        assert_eq!(after.agent, before.agent);
        assert_refused(&env.gplace("G1 still 3 SOL after the migration", &g, Order::resting(0, 4 * BASE, P0 - 10_000)), gerr::ORDER_TOO_LARGE);
        assert!(events(&env.gplace("the migrated guard trades", &g, small_bid(P0 - 1_000)))[0].accepted, "{len}");
        assert!(!after.has_last_seen || len > 950);
        if len < 950 {
            assert_eq!(after.max_daily_loss, 0, "G10 starts off on a guard made before G10");
        }
    }
}

#[test]
fn r3_1_only_the_owner_migrates_and_a_current_guard_needs_no_migration() {
    let (mut env, g) = setup();
    let agent = g.agent.insecure_clone();
    env.truncate_guard(&g, 967);
    assert!(env.migrate_guard("the agent tries to migrate", &g, &agent).is_err());
    let owner = g.owner.insecure_clone();
    assert_ok(&env.migrate_guard("the owner migrates", &g, &owner));
    assert!(env.migrate_guard("migrating again", &g, &owner).is_err(), "already the current size");
}

#[test]
fn r3_1_close_returns_the_rent_and_the_guard_can_be_created_again() {
    let (mut env, g) = setup();
    let owner = g.owner.insecure_clone();
    let agent = g.agent.insecure_clone();
    assert!(env.close_guard("the agent tries to close", &g, &agent).is_err());
    let before = env.svm.get_balance(&owner.pubkey()).unwrap();
    assert_ok(&env.close_guard("the owner closes the guard", &g, &owner));
    assert!(env.svm.get_balance(&owner.pubkey()).unwrap() > before, "rent back to the owner");
    assert!(env.svm.get_account(&g.guard).map(|a| a.data.is_empty()).unwrap_or(true), "closed");
    assert_ok(&env.init_guard_again("the owner creates the guard again", &g, &Limits::loose()));
    assert!(events(&env.gplace("the new guard trades", &g, small_bid(P0)))[0].accepted);
}

#[test]
fn r3_1_an_older_guard_can_also_be_closed() {
    let (mut env, g) = setup();
    let owner = g.owner.insecure_clone();
    env.truncate_guard(&g, 865);
    assert_ok(&env.close_guard("the owner closes a guard of the oldest layout", &g, &owner));
    assert_ok(&env.init_guard_again("and creates it again", &g, &Limits::loose()));
}

// ---------------------------------------------------------------- R3-2: the keeper is part of G10

#[test]
fn r3_2_a_daily_loss_cap_needs_a_keeper() {
    let (mut env, g) = setup();
    let owner = g.owner.insecure_clone();
    assert_refused_tx(&env.set_daily_loss_only("cap 20 with no keeper", &g, &owner, 20 * QUOTE), gerr::KEEPER_REQUIRED);
    assert_ok(&env.set_daily_loss_only("cap 0 (off) needs no keeper", &g, &owner, 0));
    assert_ok(&env.set_daily_loss("keeper first, then cap 20", &g, &owner, 20 * QUOTE));
}

/// The audit's probe: long 5, cap 20. At 23:59 the price is 5% down and the agent sends a refused cancel; at 00:00:30
/// it has recovered; at 02:00 it is 5% down again and the agent bids.
fn midnight_dip(keeper_marks: bool) -> TxResult {
    let (mut env, g) = setup();
    let flow = env.trader("flow", 1_000_000);
    assert_ok(&env.gplace("agent bids 5 SOL", &g, Order::resting(0, 5 * BASE, P0)));
    env.step(2, P0);
    env.cross("flow sells", &flow, &g, 1, 1_000 * BASE, P0);
    env.step(2, P0);
    let owner = g.owner.insecure_clone();
    assert_ok(&env.set_daily_loss("keeper (the owner) and cap 20", &g, &owner, 20 * QUOTE));
    assert!(events(&env.gplace("a call during the day", &g, small_bid(P0)))[0].accepted);
    let dip = (P0 as f64 * 0.95) as u64;
    let to_2359 = 86_400 - 60 - env.now().rem_euclid(86_400);
    env.step((to_2359 * 5 / 2) as u64, dip);
    assert_ok(&env.gcancel("23:59, at the dip: a refused cancel", &g, Some(999_999)));
    env.step((90 * 5 / 2) as u64, P0); // 00:00:30, recovered
    if keeper_marks {
        assert_ok(&env.checkpoint_as("the keeper marks the day at 00:00:30", &g, &owner));
    }
    env.step(((2 * 3600 - 30) * 5 / 2) as u64, dip); // 02:00, down 5% again
    env.gplace("02:00: the agent's first bid of the day", &g, small_bid(dip))
}

#[test]
fn r3_2_a_pre_midnight_dip_does_not_lower_the_next_days_baseline() {
    // with the keeper's midnight mark
    assert_refused(&midnight_dip(true), gerr::DAILY_LOSS_EXCEEDED);
    // and even without it: in the last hour before midnight an observation may only raise the last equity seen
    assert_refused(&midnight_dip(false), gerr::DAILY_LOSS_EXCEEDED);
}
