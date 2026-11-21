//! REPLAY e2e: a scripted runaway agent keeps doubling a long into a falling market. The same price path and the same
//! counterparty flow run twice: once with the agent as Velocity's delegate directly (unguarded), once through the
//! guard. Prices are written by the test (a replay, not live data). Breaches are computed from raw account bytes.

use guardrail_tests::*;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

const P0: u64 = 91_390_000;
const STEPS: usize = 14;
/// G10 in the headline guarded runs: 50 dUSDT a day, 5% of the 1,000 dUSDT account.
const DAILY_LOSS: u64 = 50_000_000;

fn guarded_limits() -> Limits {
    let mut l = Limits::loose();
    l.max_order_base = 4 * BASE; // G1
    l.markets[0] = (0, 10 * BASE); // G4
    l.allowed_order_types = T_LIMIT; // G2
    l.daily_notional_cap = 1_500_000_000; // G3: 1,500 dUSDT a day
    l.max_leverage_bps = 20_000; // G5: 2x
    l.price_band_bps = 200; // G6: 2%
    l.max_oracle_staleness_slots = 50;
    l
}

#[derive(Default, Debug)]
struct Run {
    lines: Vec<String>,
    accepted: u32,
    refused_by: std::collections::BTreeMap<String, u32>,
    velocity_refused: u32,
    breaches: u32,
    start_equity: i128,
    min_equity: i128,
    end_equity: i128,
    max_position: i64,
    max_leverage_bps: i128,
    /// Per-step state for the dashboard's playback (price, position, open orders, PnL, each decision and its rule).
    steps: Vec<serde_json::Value>,
}

fn equity(env: &Env, owner: &Address, price: u64) -> i128 {
    let (base, quote, _, _) = env.totals(owner);
    env.raw_collateral(owner) + base as i128 * price as i128 / BASE as i128 + quote as i128
}

fn worst(env: &Env, owner: &Address) -> i128 {
    let (base, _, bids, asks) = env.totals(owner);
    (base as i128 + bids as i128).abs().max((base as i128 + asks as i128).abs())
}

fn name(code: u32) -> String {
    match code {
        6000 => "G1 order size",
        6001 | 6002 | 6003 | 6013 | 6014 | 6015 | 6016 => "G2 allowlist",
        6004 => "G3 daily notional",
        6005 => "G4 exposure",
        6006 => "G5 leverage",
        6007 => "G6 price band",
        6022 | 6024 => "G5 balances / equity",
        6009 => "G7 paused",
        6032 => "G10 daily loss",
        _ => "other",
    }
    .to_string()
}

/// `daily_loss`: the owner's G10 cap in quote units (0 = off).
fn run(guarded: bool, limits: Limits, daily_loss: u64) -> Run {
    let mut env = Env::new();
    env.quiet = true; // the unguarded run's expected Velocity margin refusals would flood the output
    env.add_guard_program();
    env.step(1, P0);
    let g = if guarded {
        let g = env.guarded(1_000, limits);
        if daily_loss > 0 {
            let owner = g.owner.insecure_clone();
            assert_ok(&env.set_daily_loss("owner sets the daily loss cap", &g, &owner, daily_loss));
        }
        g
    } else {
        // Unguarded: the owner makes the agent key the Velocity delegate directly.
        let owner = env.trader("owner", 1_000);
        let agent = Keypair::new();
        env.svm.airdrop(&agent.pubkey(), 1_000_000_000).unwrap();
        let r = env.send("owner: agent key becomes the Velocity delegate", vec![Env::delegate_ix(&owner.pubkey(), &agent.pubkey())], &[&owner]);
        assert_ok(&r);
        let user = user_pda(&owner.pubkey());
        Guarded { owner, agent, user, guard: Address::default() }
    };
    let flow = env.trader("flow", 2_000_000);
    let owner = g.owner.pubkey();
    let mut out = Run { start_equity: equity(&env, &owner, P0), ..Default::default() };
    out.min_equity = out.start_equity;
    let mut day_notional: i128 = 0;
    let mut price = P0;
    let mut size = BASE / 2;
    for step in 0..STEPS {
        env.step(10, price);
        let bid_price = (price * 999 / 1000) / 10 * 10; // 0.1% under the oracle, on the tick
        // The runaway loop: it wants to add `size`; when an order is refused it halves the chunk and keeps trying.
        let mut left = size;
        let mut chunk = size;
        let mut attempts: Vec<String> = vec![];
        let mut decisions: Vec<serde_json::Value> = vec![];
        for _ in 0..12 {
            if left == 0 || chunk < BASE / 10 {
                break;
            }
            let this = chunk.min(left);
            let pre_eq = equity(&env, &owner, price);
            let o = Order::resting(0, this, bid_price);
            let r = if guarded {
                env.gplace(&format!("step {step}: agent -> guard BUY {}", this as f64 / 1e9), &g, o)
            } else {
                let mut data = disc("place_perp_order").to_vec();
                data.extend(o.bytes());
                let mut accounts = vec![AccountMeta::new_readonly(STATE, false), AccountMeta::new(g.user, false), AccountMeta::new_readonly(g.agent.pubkey(), true)];
                accounts.extend(Env::maps());
                let agent = g.agent.insecure_clone();
                env.send(&format!("step {step}: agent -> Velocity BUY {}", this as f64 / 1e9), vec![Instruction { program_id: VELOCITY, accounts, data }], &[&agent])
            };
            let refused_reason = match &r {
                Ok(_) => events(&r).first().filter(|e| !e.accepted).map(|e| e.reason),
                Err(_) => None,
            };
            if let Some(c) = refused_reason {
                *out.refused_by.entry(name(c)).or_default() += 1;
                attempts.push(format!("{}x{}", this as f64 / 1e9, &name(c)[..2]));
                let e = events(&r)[0].clone();
                decisions.push(serde_json::json!({"size": this as f64 / 1e9, "result": "refused", "by": name(c), "reason": c, "value": e.value as f64, "cap": e.cap as f64, "rule": e.rule}));
                chunk /= 2;
                continue;
            }
            match &r {
                Ok(_) => {
                    out.accepted += 1;
                    day_notional += this as i128 * price as i128 / BASE as i128;
                    // Breach check at acceptance, from raw bytes (order size, exposure, leverage, daily notional).
                    let w = worst(&env, &owner);
                    let eq = equity(&env, &owner, price);
                    let lev = if eq > 0 { w * price as i128 / BASE as i128 * 10_000 / eq } else { i128::MAX };
                    // G10 at acceptance: the loss since the day's start (no deposits or withdrawals in this replay),
                    // measured before this order, must not be over the cap.
                    let g10 = daily_loss > 0 && out.start_equity - pre_eq > daily_loss as i128;
                    if guarded && (w > limits.markets[0].1 as i128 || lev > limits.max_leverage_bps as i128 || day_notional > limits.daily_notional_cap as i128 || this > limits.max_order_base || g10) {
                        out.breaches += 1;
                    }
                    env.step(2, price);
                    let filled = env.cross(&format!("step {step}: flow sells into the bid"), &flow, &g, 1, 5_000 * BASE, bid_price);
                    left = left.saturating_sub(filled.max(0) as u64);
                    attempts.push(format!("{}ok", this as f64 / 1e9));
                    decisions.push(serde_json::json!({"size": this as f64 / 1e9, "result": "accepted", "filled": filled as f64 / 1e9}));
                }
                Err(_) => {
                    let c = code(&r);
                    assert!(!(guarded && (6000..6100).contains(&c)), "a guard error (not a refusal) in the replay: {c}");
                    out.velocity_refused += 1;
                    attempts.push(format!("{}xV", this as f64 / 1e9));
                    decisions.push(serde_json::json!({"size": this as f64 / 1e9, "result": "velocity", "by": "Velocity margin check", "reason": c}));
                    chunk /= 2;
                }
            }
        }
        let outcome = attempts.join(" ");
        let (base, _, _, _) = env.totals(&owner);
        let eq = equity(&env, &owner, price);
        let lev = if eq > 0 { base.unsigned_abs() as i128 * price as i128 / BASE as i128 * 10_000 / eq } else { i128::MAX };
        out.max_position = out.max_position.max(base);
        out.max_leverage_bps = out.max_leverage_bps.max(lev);
        out.min_equity = out.min_equity.min(eq);
        let (b2, q2, bids2, asks2) = env.totals(&owner);
        let coll = env.raw_collateral(&owner);
        out.steps.push(serde_json::json!({
            "step": step, "price": price as f64 / 1e6, "wants": size as f64 / 1e9, "decisions": decisions,
            "position": b2 as f64 / 1e9, "openBids": bids2 as f64 / 1e9, "openAsks": (asks2 as f64 / 1e9).abs(),
            "collateral": coll as f64 / 1e6, "upnl": (b2 as i128 * price as i128 / BASE as i128 + q2 as i128) as f64 / 1e6,
            "equity": eq as f64 / 1e6, "leverage": lev as f64 / 1e4,
            "lossPct": ((out.start_equity - eq) as f64 / out.start_equity as f64 * 100.0),
        }));
        out.lines.push(format!(
            "step {:>2} price ${:>6.2} wants +{:>7.2} SOL, tries: {:<44} position {:>7.3} SOL equity {:>9.2} leverage {:>5.2}x",
            step, price as f64 / 1e6, size as f64 / 1e9, outcome, base as f64 / 1e9, eq as f64 / 1e6, lev as f64 / 1e4
        ));
        size *= 2;
        price = price * 99 / 100;
    }
    if guarded {
        let st = env.guard_state(&g);
        out.lines.push(format!(
            "Guard account counters (on chain): accepted {}, refused G1 {} G2 {} G3 {} G4 {} G5 {} G6 {} G7 {} G10 {}; last refusal rule {} reason {} value {} cap {} slot {}",
            st.accepted_count, st.refused[1], st.refused[2], st.refused[3], st.refused[4], st.refused[5], st.refused[6], st.refused[7], st.refused_g10,
            st.last_refusal.rule, st.last_refusal.reason, st.last_refusal.value, st.last_refusal.cap, st.last_refusal.slot
        ));
        assert_eq!(st.accepted_count, out.accepted as u64, "on-chain accepted count matches the replay");
        let on_chain: u64 = st.refused.iter().sum::<u64>() + st.refused_g10;
        let tallied: u32 = out.refused_by.values().sum();
        assert_eq!(on_chain, tallied as u64, "on-chain refusal counters match the replay");
    }
    env.step(10, price);
    out.end_equity = equity(&env, &owner, price);
    out.min_equity = out.min_equity.min(out.end_equity);
    // The final mark: one more 1% move with no new orders, where the worst loss is measured.
    let (b2, q2, bids2, asks2) = env.totals(&owner);
    let eq = out.end_equity;
    let lev = if eq > 0 { b2.unsigned_abs() as i128 * price as i128 / BASE as i128 * 10_000 / eq } else { i128::MAX };
    let n = out.steps.len();
    out.steps.push(serde_json::json!({
        "step": n, "final": true, "price": price as f64 / 1e6, "wants": 0.0, "decisions": [],
        "position": b2 as f64 / 1e9, "openBids": bids2 as f64 / 1e9, "openAsks": (asks2 as f64 / 1e9).abs(),
        "collateral": env.raw_collateral(&owner) as f64 / 1e6, "upnl": (b2 as i128 * price as i128 / BASE as i128 + q2 as i128) as f64 / 1e6,
        "equity": eq as f64 / 1e6, "leverage": lev as f64 / 1e4,
        "lossPct": ((out.start_equity - eq) as f64 / out.start_equity as f64 * 100.0),
    }));
    out
}

#[test]
fn replay_runaway_agent_unguarded_vs_guarded() {
    let u = run(false, guarded_limits(), 0);
    let g = run(true, guarded_limits(), DAILY_LOSS);
    // Same agent with the exposure cap loosened to 100 SOL, so the daily notional limit binds instead.
    let mut l2 = guarded_limits();
    l2.markets[0] = (0, 100 * BASE);
    let g2 = run(true, l2, DAILY_LOSS);
    let mut report = vec![
        "REPLAY: Velocity devnet binary, devnet state cloned Nov 21 2026; SOL price written by the test: $91.39 falling 1% per step.".to_string(),
        "Agent loop: every step it wants to add double the previous size (0.5, 1, 2, 4 ... SOL), bidding 0.1% under the oracle; when an order is refused it halves the order and retries (up to 12 tries a step). A flow account sells into each accepted bid. Tries: 4ok = 4 SOL accepted, 8xG1 = 8 SOL refused by G1, xV = refused by Velocity margin.".to_string(),
        format!("Guard limits: G1 4 SOL per order, G4 10 SOL worst-case exposure, G3 1,500 dUSDT a day, G5 2x, G6 2% band, G10 50 dUSDT daily loss, Limit orders only."),
        String::new(),
        "UNGUARDED (agent is the Velocity delegate)".to_string(),
    ];
    report.extend(u.lines.iter().cloned());
    report.push(String::new());
    report.push("GUARDED (agent trades only through the guard)".to_string());
    report.extend(g.lines.iter().cloned());
    report.push(String::new());
    report.push("GUARDED, exposure cap loosened to 100 SOL (the daily notional cap G3 binds)".to_string());
    report.extend(g2.lines.iter().cloned());
    report.push(String::new());
    let loss = |r: &Run| (r.start_equity - r.min_equity) as f64 / 1e6;
    let end_loss = |r: &Run| (r.start_equity - r.end_equity) as f64 / 1e6;
    report.push(format!(
        "HEADLINE  unguarded: worst loss {:.2} dUSDT of {:.2} ({:.1}%), end loss {:.2}, max position {:.2} SOL, max leverage {:.2}x, orders accepted {}, refused by Velocity margin {}",
        loss(&u), u.start_equity as f64 / 1e6, loss(&u) / (u.start_equity as f64 / 1e6) * 100.0, end_loss(&u), u.max_position as f64 / 1e9, u.max_leverage_bps as f64 / 1e4, u.accepted, u.velocity_refused
    ));
    report.push(format!(
        "HEADLINE  guarded:   worst loss {:.2} dUSDT of {:.2} ({:.1}%), end loss {:.2}, max position {:.2} SOL, max leverage {:.2}x, orders accepted {}, refused by the guard {:?}, refused by Velocity {}, breaches {}",
        loss(&g), g.start_equity as f64 / 1e6, loss(&g) / (g.start_equity as f64 / 1e6) * 100.0, end_loss(&g), g.max_position as f64 / 1e9, g.max_leverage_bps as f64 / 1e4, g.accepted, g.refused_by, g.velocity_refused, g.breaches
    ));
    report.push(format!(
        "HEADLINE  guarded (G4 at 100 SOL): worst loss {:.2} dUSDT ({:.1}%), max position {:.2} SOL, max leverage {:.2}x, orders accepted {}, refused by the guard {:?}, refused by Velocity {}, breaches {}",
        loss(&g2), loss(&g2) / (g2.start_equity as f64 / 1e6) * 100.0, g2.max_position as f64 / 1e9, g2.max_leverage_bps as f64 / 1e4, g2.accepted, g2.refused_by, g2.velocity_refused, g2.breaches
    ));
    report.push("Breach = an accepted order that left order size, worst-case exposure, leverage or daily notional over its cap at acceptance, or was accepted while the day's loss was over the G10 cap, measured from raw account bytes. Leverage drifting up afterwards from price alone is not counted (shown in the leverage column).".to_string());
    let text = report.join("\n");
    println!("{text}");
    { let _ = std::fs::create_dir_all(concat!(env!("CARGO_MANIFEST_DIR"), "/../out")); }
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../out/runaway-replay.txt"), &text).unwrap();
    // Playback data for the dashboard: per-step state of each run (REPLAY, prices written by the test).
    let g3 = run(true, leverage_limits(), 0);
    // Only the daily-loss brake can bind: G1, G3, G4 and G5 loose, G10 at 20 dUSDT (2% of the account).
    let mut l4 = leverage_limits();
    l4.max_leverage_bps = 1_000_000;
    let g4 = run(true, l4, 20_000_000);
    let as_json = |id: &str, title: &str, limits: &str, r: &Run| serde_json::json!({
        "id": id, "title": title, "limits": limits, "steps": r.steps,
        "summary": {
            "worstLoss": loss(r), "worstLossPct": loss(r) / (r.start_equity as f64 / 1e6) * 100.0,
            "maxPosition": r.max_position as f64 / 1e9, "maxLeverage": r.max_leverage_bps as f64 / 1e4,
            "accepted": r.accepted, "refusedBy": r.refused_by, "velocityRefused": r.velocity_refused, "breaches": r.breaches,
        }
    });
    let replay = serde_json::json!({
        "label": "REPLAY: Velocity's real devnet binary in LiteSVM, devnet state cloned Nov 21 2026, the SOL price written by the test ($91.39 falling 1% a step), real fills from a second account. Not live trading.",
        "agent": "Every step the agent wants to add double the previous size, bidding 0.1% under the oracle; when an order is refused it halves the order and retries.",
        "collateral": u.start_equity as f64 / 1e6,
        "runs": [
            as_json("unguarded", "Unguarded: the agent is Velocity's delegate", "none (Velocity's own 5x margin check only)", &u),
            as_json("guarded", "Guarded", "G1 4 SOL per order, G4 10 SOL worst case, G3 1,500 dUSDT a day, G5 2x, G6 2%, G10 50 dUSDT daily loss", &g),
            as_json("guarded-g3", "Guarded, exposure cap loosened", "G4 100 SOL, the rest as guarded", &g2),
            as_json("guarded-g5", "Guarded, only leverage can bind", "G1, G3 and G4 loose; G5 2x", &g3),
            as_json("guarded-g10", "Guarded, only the daily loss brake can bind", "G1, G3, G4 and G5 loose; G10 20 dUSDT a day", &g4),
        ]
    });
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../out/replay.json"), serde_json::to_string_pretty(&replay).unwrap()).unwrap();
    assert_eq!(g.breaches, 0, "zero breaches guarded");
    assert_eq!(g2.breaches, 0, "zero breaches guarded (second limit set)");
    assert_eq!(g3.breaches, 0, "zero breaches guarded (leverage limit set)");
    assert_eq!(g4.breaches, 0, "zero breaches guarded (daily loss brake only)");
    assert!(g.refused_by.get("G10 daily loss").copied().unwrap_or(0) > 0, "G10 binds in the headline guarded run");
    assert!(g4.refused_by.get("G10 daily loss").copied().unwrap_or(0) > 0, "G10 binds when it is the only tight limit");
    let g10_line = format!(
        "HEADLINE  guarded (only G10 at 20 dUSDT): worst loss {:.2} dUSDT ({:.1}%), max position {:.2} SOL, max leverage {:.2}x, orders accepted {}, refused by the guard {:?}, refused by Velocity {}, breaches {}",
        loss(&g4), loss(&g4) / (g4.start_equity as f64 / 1e6) * 100.0, g4.max_position as f64 / 1e9, g4.max_leverage_bps as f64 / 1e4, g4.accepted, g4.refused_by, g4.velocity_refused, g4.breaches
    );
    println!("{g10_line}");
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../out/runaway-replay.txt"), format!("{text}\n{g10_line}\nThe daily-loss brake stops new risk; it does not close a position, so a held position keeps losing as the price falls.\n")).unwrap();
    assert!(loss(&g2) < loss(&u));
    assert!(loss(&g) < loss(&u), "guarded loses less");
}

/// Limits where only leverage can bind: order size, exposure and daily notional are loose, G5 is 2x.
fn leverage_limits() -> Limits {
    let mut l = guarded_limits();
    l.max_order_base = 100_000 * BASE;
    l.markets[0] = (0, 100_000 * BASE);
    l.daily_notional_cap = 1_000_000_000_000;
    l.max_leverage_bps = 20_000;
    l
}

#[test]
fn replay_leverage_cap_binds_when_losses_shrink_equity() {
    // The same runaway agent and price path, with every limit loose except G5 (2x). As the long loses, equity falls,
    // and the leverage cap is what stops the agent; it never breaches, and it loses less than unguarded.
    let u = run(false, guarded_limits(), 0);
    let g = run(true, leverage_limits(), 0);
    let loss = |r: &Run| (r.start_equity - r.min_equity) as f64 / 1e6;
    println!(
        "G5 REPLAY guarded: worst loss {:.2} dUSDT, max position {:.2} SOL, max leverage {:.2}x, accepted {}, refused {:?}, breaches {}; unguarded worst loss {:.2}",
        loss(&g), g.max_position as f64 / 1e9, g.max_leverage_bps as f64 / 1e4, g.accepted, g.refused_by, g.breaches, loss(&u)
    );
    for l in &g.lines {
        println!("{l}");
    }
    assert!(g.refused_by.get("G5 leverage").copied().unwrap_or(0) >= 1, "G5 is the binding refusal: {:?}", g.refused_by);
    for other in ["G1 order size", "G3 daily notional", "G4 exposure"] {
        assert_eq!(g.refused_by.get(other).copied().unwrap_or(0), 0, "{other} does not bind here");
    }
    assert_eq!(g.velocity_refused, 0, "the guard stops it before Velocity's own margin check");
    assert_eq!(g.breaches, 0);
    assert!(loss(&g) < loss(&u));
}
