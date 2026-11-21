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
        _ => "other",
    }
    .to_string()
}

fn run(guarded: bool, limits: Limits) -> Run {
    let mut env = Env::new();
    env.add_guard_program();
    env.step(1, P0);
    let g = if guarded {
        env.guarded(1_000, limits)
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
        for _ in 0..12 {
            if left == 0 || chunk < BASE / 10 {
                break;
            }
            let this = chunk.min(left);
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
                    if guarded && (w > limits.markets[0].1 as i128 || lev > limits.max_leverage_bps as i128 || day_notional > limits.daily_notional_cap as i128 || this > limits.max_order_base) {
                        out.breaches += 1;
                    }
                    env.step(2, price);
                    let filled = env.cross(&format!("step {step}: flow sells into the bid"), &flow, &g, 1, 5_000 * BASE, bid_price);
                    left = left.saturating_sub(filled.max(0) as u64);
                    attempts.push(format!("{}ok", this as f64 / 1e9));
                }
                Err(_) => {
                    let c = code(&r);
                    assert!(!(guarded && (6000..6100).contains(&c)), "a guard error (not a refusal) in the replay: {c}");
                    out.velocity_refused += 1;
                    attempts.push(format!("{}xV", this as f64 / 1e9));
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
        out.lines.push(format!(
            "step {:>2} price ${:>6.2} wants +{:>7.2} SOL, tries: {:<44} position {:>7.3} SOL equity {:>9.2} leverage {:>5.2}x",
            step, price as f64 / 1e6, size as f64 / 1e9, outcome, base as f64 / 1e9, eq as f64 / 1e6, lev as f64 / 1e4
        ));
        size *= 2;
        price = price * 99 / 100;
    }
    env.step(10, price);
    out.end_equity = equity(&env, &owner, price);
    out.min_equity = out.min_equity.min(out.end_equity);
    out
}

#[test]
fn replay_runaway_agent_unguarded_vs_guarded() {
    let u = run(false, guarded_limits());
    let g = run(true, guarded_limits());
    // Same agent with the exposure cap loosened to 100 SOL, so the daily notional limit binds instead.
    let mut l2 = guarded_limits();
    l2.markets[0] = (0, 100 * BASE);
    let g2 = run(true, l2);
    let mut report = vec![
        "REPLAY: Velocity devnet binary, devnet state cloned Nov 21 2026; SOL price written by the test: $91.39 falling 1% per step.".to_string(),
        "Agent loop: every step it wants to add double the previous size (0.5, 1, 2, 4 ... SOL), bidding 0.1% under the oracle; when an order is refused it halves the order and retries (up to 12 tries a step). A flow account sells into each accepted bid. Tries: 4ok = 4 SOL accepted, 8xG1 = 8 SOL refused by G1, xV = refused by Velocity margin.".to_string(),
        format!("Guard limits: G1 4 SOL per order, G4 10 SOL worst-case exposure, G3 1,500 dUSDT a day, G5 2x, G6 2% band, Limit orders only."),
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
    report.push("Breach = an accepted order that left order size, worst-case exposure, leverage or daily notional over its cap at acceptance, measured from raw account bytes. Leverage drifting up afterwards from price alone is not counted (shown in the leverage column).".to_string());
    let text = report.join("\n");
    println!("{text}");
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../notes/runaway-replay.txt"), &text).unwrap();
    assert_eq!(g.breaches, 0, "zero breaches guarded");
    assert_eq!(g2.breaches, 0, "zero breaches guarded (second limit set)");
    assert!(loss(&g2) < loss(&u));
    assert!(loss(&g) < loss(&u), "guarded loses less");
}
