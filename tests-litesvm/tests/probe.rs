//! REPLAY probes of Velocity's own behaviour (no guard): reduce-only semantics and how fills split with the vAMM.
use guardrail_tests::*;
use solana_signer::Signer;

fn pos(env: &Env, k: &solana_keypair::Keypair) -> (i64, i64, i64) {
    let u = env.user(&k.pubkey());
    let mut t = (0, 0, 0);
    for p in u.perp.iter().filter(|p| p.market_index == 0) {
        t.0 += p.base_asset_amount;
        t.1 += p.open_bids;
        t.2 += p.open_asks;
    }
    t
}

#[test]
fn probe_reduce_only_and_fill_split() {
    let mut env = Env::new();
    let p0 = 91_390_000;
    env.step(1, p0);
    let a = env.trader("agent", 1_000);
    let flow = env.trader("flow", 1_000_000);

    // A: reduce-only bid with no position
    let mut o = Order::limit(0, BASE, 91_000_000);
    o.post_only = 1;
    o.reduce_only = true;
    let r = env.place("A reduce-only BUY 1 with no position", &a, o);
    env.note(format!("A ok={} pos(base,bids,asks)={:?}", r.is_ok(), pos(&env, &a)));

    // Fill split: agent bids 1 SOL @ 91.30; flow sells 50 SOL limit 91.30 against it
    env.step(2, p0);
    let mut bid = Order::limit(0, BASE, 91_300_000);
    bid.post_only = 1;
    let r = env.place("agent BUY 1 @ 91.30 (rests)", &a, bid);
    env.note(format!("bid ok={} pos={:?}", r.is_ok(), pos(&env, &a)));
    env.step(2, p0);
    let ap = a.pubkey();
    let r = env.place_and_take("flow SELL 50 limit 91.30 with agent as maker", &flow, Order::limit(1, 50 * BASE, 91_300_000), &[&ap]);
    env.note(format!("flow ok={} agent pos={:?} flow pos={:?}", r.is_ok(), pos(&env, &a), pos(&env, &flow)));

    // B: reduce-only BUY in the same direction as a long position
    env.step(2, p0);
    let mut o = Order::limit(0, BASE, 91_000_000);
    o.post_only = 1;
    o.reduce_only = true;
    let r = env.place("B reduce-only BUY while long", &a, o);
    env.note(format!("B ok={} pos={:?}", r.is_ok(), pos(&env, &a)));

    // C: reduce-only SELL larger than the position, then flow buys through it
    env.step(2, p0);
    let mut o = Order::limit(1, 3 * BASE, 91_500_000);
    o.post_only = 1;
    o.reduce_only = true;
    let r = env.place("C reduce-only SELL 3 (position is ~1)", &a, o);
    env.note(format!("C place ok={} pos={:?}", r.is_ok(), pos(&env, &a)));
    // D: a second stacked reduce-only sell
    let mut o2 = Order::limit(1, BASE, 91_600_000);
    o2.post_only = 1;
    o2.reduce_only = true;
    o2.user_order_id = 9;
    let r = env.place("D second reduce-only SELL 1 stacked", &a, o2);
    env.note(format!("D place ok={} pos={:?} orders={:?}", r.is_ok(), pos(&env, &a), env.user(&a.pubkey()).open_orders));
    env.step(2, p0);
    let r = env.place_and_take("flow BUY 50 limit 91.60 with agent as maker", &flow, Order::limit(0, 50 * BASE, 91_600_000), &[&ap]);
    env.note(format!("flow ok={} agent pos after exits={:?} orders={:?}", r.is_ok(), pos(&env, &a), env.user(&a.pubkey()).open_orders));
    { let _ = std::fs::create_dir_all(concat!(env!("CARGO_MANIFEST_DIR"), "/../out")); }
    std::fs::write(format!("{}/../out/probe-velocity.txt", env!("CARGO_MANIFEST_DIR")), env.log.join("\n")).unwrap();
}

/// Can a reduce-only exit be sold far under the oracle to a partner? (Decides whether G9 exits need the price band.)
#[test]
fn probe_exit_price_far_under_oracle() {
    let mut env = Env::new();
    let p0 = 91_390_000;
    env.step(1, p0);
    let a = env.trader("agent", 1_000);
    let flow = env.trader("flow", 1_000_000);
    let partner = env.trader("partner", 100_000);
    env.step(2, p0);
    assert!(env.place("agent BUY 1 @ 91.30", &a, Order::resting(0, BASE, 91_300_000)).is_ok());
    env.step(2, p0);
    let ap = a.pubkey();
    assert!(env.place_and_take("flow sells into it", &flow, Order::limit(1, 50 * BASE, 91_300_000), &[&ap]).is_ok());
    env.note(format!("agent position {:?}", pos(&env, &a)));
    for (label, price) in [("12.5% under", 80_000_000u64), ("25% under", 68_500_000)] {
        env.step(2, p0);
        let mut exit = Order::limit(1, BASE, price);
        exit.reduce_only = true;
        let r = env.place(&format!("agent reduce-only SELL 1 @ {label} (not post-only)"), &a, exit);
        env.note(format!("place ok={} orders={:?}", r.is_ok(), env.user(&a.pubkey()).open_orders));
        env.step(40, p0); // let any auction finish
        let pp = partner.pubkey();
        let before = pos(&env, &partner);
        let r = env.place_and_take(&format!("partner BUY 1 limit {label} with the agent as maker"), &partner, Order::limit(0, BASE, price), &[&ap]);
        let after = pos(&env, &partner);
        let pu = env.user(&pp);
        env.note(format!(
            "partner take ok={} partner base {} -> {}, partner perp {:?}; agent {:?}",
            r.is_ok(), before.0, after.0, pu.perp, pos(&env, &a)
        ));
        let _ = env.gcancel_raw(&a);
    }
    { let _ = std::fs::create_dir_all(concat!(env!("CARGO_MANIFEST_DIR"), "/../out")); }
    std::fs::write(format!("{}/../out/probe-exit-price.txt", env!("CARGO_MANIFEST_DIR")), env.log.join("\n")).unwrap();
}

/// What Velocity records for deposits and withdrawals (for G10's flow adjustment): total_deposits at 4392 and
/// total_withdraws at 4400, in quote units valued at the quote oracle price.
#[test]
fn probe_deposit_and_withdraw_totals() {
    let mut env = Env::new();
    env.add_guard_program();
    env.step(1, 91_390_000);
    let k = env.trader("owner", 1_000);
    let a = k.pubkey();
    let (d0, w0) = env.flows(&a);
    let c0 = env.raw_collateral(&a);
    assert_ok(&env.deposit_more("deposit 250", &k, 250));
    let (d1, w1) = env.flows(&a);
    let c1 = env.raw_collateral(&a);
    env.step(2, 91_390_000);
    assert_ok(&env.withdraw("withdraw 100", &k, 100));
    let (d2, w2) = env.flows(&a);
    let c2 = env.raw_collateral(&a);
    println!("PROBE flows: start d={d0} w={w0} c={c0}; after +250 d={d1} w={w1} c={c1}; after -100 d={d2} w={w2} c={c2}");
    assert!(d1 > d0 && w1 == w0, "a deposit moves total_deposits");
    assert!(w2 > w1 && d2 == d1, "a withdraw moves total_withdraws");
}
