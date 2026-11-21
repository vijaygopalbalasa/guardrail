//! REPLAY sweep: a natural (non-martingale) agent on 30 seeded random price paths, guarded vs unguarded.
//!
//! The agent is a plain grid bot with a fixed size: it wants to buy 2 SOL at every 1% level below the starting price
//! (10 levels) and, after each buy, sell that 2 SOL one level higher; it keeps orders within 3% of the price it sees.
//! It never doubles. Each step the SOL price moves
//! by a seeded random amount (written by the test); a resting order fills when the price passes through it (a flow
//! account takes it at its limit). The same path and the same flow run twice: once with the agent as Velocity's
//! delegate directly, once through the guard. Breaches are measured from raw account bytes, not the guard's code.

use guardrail_tests::*;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use std::collections::BTreeMap;

const P0: u64 = 91_390_000;
const STEPS: usize = 60;
const SEEDS: u64 = 30;
const LEVELS: i64 = 10;
const SIZE: u64 = 2 * BASE;
const SIGMA: f64 = 0.012; // 1.2% a step
/// The bot keeps orders only within this distance of the price it sees (its own window, wider than the 2% band).
const WINDOW_BPS: u64 = 300;
const DAILY_LOSS: u64 = 100_000_000; // G10: 100 dUSDT a day

fn sweep_limits() -> Limits {
    let mut l = Limits::loose();
    l.max_order_base = 4 * BASE; // G1
    l.markets[0] = (0, 30 * BASE); // G4: 30 SOL worst case
    l.allowed_order_types = T_LIMIT; // G2
    l.daily_notional_cap = 100_000_000_000; // G3: 100,000 dUSDT a day (not meant to bind)
    l.max_leverage_bps = 15_000; // G5: 1.5x
    l.price_band_bps = 200; // G6: 2%
    l.max_oracle_staleness_slots = 50;
    l
}

/// xorshift64* with Box-Muller: a seeded path, the same for both runs.
fn path(seed: u64) -> Vec<u64> {
    let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut next = || {
        s ^= s >> 12;
        s ^= s << 25;
        s ^= s >> 27;
        (s.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    };
    let mut p = P0 as f64;
    let mut out = vec![P0];
    for _ in 0..STEPS {
        let (u1, u2) = (next().max(1e-12), next());
        let z = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
        p *= 1.0 + SIGMA * z;
        out.push((p as u64) / 10 * 10);
    }
    out
}

fn level(k: i64) -> u64 {
    ((P0 as f64 * (1.0 + k as f64 / 100.0)) as u64) / 10 * 10
}

fn equity(env: &Env, owner: &Pubkey, price: u64) -> i128 {
    let (base, quote, _, _) = env.totals(owner);
    env.raw_collateral(owner) + base as i128 * price as i128 / BASE as i128 + quote as i128
}

fn worst(env: &Env, owner: &Pubkey) -> i128 {
    let (base, _, bids, asks) = env.totals(owner);
    (base as i128 + bids as i128).abs().max((base as i128 + asks as i128).abs())
}

fn name(code: u32) -> String {
    match code {
        6000 => "G1 order size",
        6004 => "G3 daily notional",
        6005 => "G4 exposure",
        6006 => "G5 leverage",
        6007 => "G6 price band",
        6032 => "G10 daily loss",
        _ => "other",
    }
    .to_string()
}

#[derive(Default, Debug, Clone)]
struct Run {
    worst_loss_pct: f64,
    end_loss_pct: f64,
    max_position: f64,
    accepted: u32,
    refused_by: BTreeMap<String, u32>,
    velocity_refused: u32,
    breaches: u32,
    fills: u32,
    /// Refusals of the grid's sells (which only reduce the long it bought), by rule.
    refused_sells: BTreeMap<String, u32>,
}

/// One grid level: buying at level k, then selling at level k + 1.
#[derive(Clone, Copy, PartialEq)]
enum Want {
    Buy,
    Sell,
}

fn run(seed: u64, guarded: bool) -> Run {
    let prices = path(seed);
    let limits = sweep_limits();
    let mut env = Env::new();
    env.quiet = true;
    env.add_guard_program();
    env.step(1, P0);
    let g = if guarded {
        let g = env.guarded(1_000, limits);
        let owner = g.owner.insecure_clone();
        assert_ok(&env.set_daily_loss("owner sets the daily loss cap", &g, &owner, DAILY_LOSS));
        g
    } else {
        let owner = env.trader("owner", 1_000);
        let agent = Keypair::new();
        env.svm.airdrop(&agent.pubkey(), 1_000_000_000).unwrap();
        assert_ok(&env.send("owner: agent key becomes the Velocity delegate", vec![Env::delegate_ix(&owner.pubkey(), &agent.pubkey())], &[&owner]));
        let user = user_pda(&owner.pubkey());
        Guarded { owner, agent, user, guard: Address::default() }
    };
    let flow = env.trader("flow", 2_000_000);
    let owner = g.owner.pubkey();
    let start = equity(&env, &owner, P0);
    let mut min_eq = start;
    let mut out = Run::default();
    // Per level k in 1..=LEVELS (price level(-k)): what the agent wants there and the resting order's price, if any.
    let mut want: Vec<Want> = vec![Want::Buy; LEVELS as usize + 1];
    let mut resting: Vec<Option<(u64, u32)>> = vec![None; LEVELS as usize + 1]; // (price, order id)
    let mut day_notional: i128 = 0;
    for (step, &price) in prices.iter().enumerate() {
        env.step(10, price);
        // 1. Fills: a resting order fills when the price has passed through it.
        for k in 1..=LEVELS as usize {
            let Some((px, id)) = resting[k] else { continue };
            let crossed = match want[k] {
                Want::Buy => price <= px,
                Want::Sell => price >= px,
            };
            if !crossed {
                continue;
            }
            let dir = if want[k] == Want::Buy { 1 } else { 0 }; // the flow takes the other side
            // The flow takes everything at the level or better (Velocity's AMM first, then the agent's order).
            env.cross(&format!("seed {seed} step {step}: flow fills level {k}"), &flow, &g, dir, 1_000 * BASE, px);
            if !raw_orders(&env, &flow.pubkey()).is_empty() {
                assert_ok(&env.gcancel_raw(&flow)); // the flow keeps no resting remainder
            }
            if !raw_orders(&env, &owner).iter().any(|o| o.order_id == id) {
                out.fills += 1;
                resting[k] = None;
                want[k] = if want[k] == Want::Buy { Want::Sell } else { Want::Buy };
            }
        }
        // 2. The grid places every missing order (it never sizes up and never doubles).
        for k in 1..=LEVELS as usize {
            if resting[k].is_some() {
                continue;
            }
            let (dir, px) = match want[k] {
                Want::Buy => (0u8, level(-(k as i64))),
                Want::Sell => (1u8, level(-(k as i64) + 1)),
            };
            // Only place orders that would rest (a buy below the price, a sell above it), as a grid bot does.
            if (dir == 0 && px >= price) || (dir == 1 && px <= price) {
                continue;
            }
            if (px as i128 - price as i128).unsigned_abs() as u64 * 10_000 > WINDOW_BPS * price {
                continue;
            }
            let pre_eq = equity(&env, &owner, price);
            let o = Order::resting(dir, SIZE, px);
            let r = if guarded {
                env.gplace(&format!("seed {seed} step {step}: grid level {k}"), &g, o)
            } else {
                let mut data = disc("place_perp_order").to_vec();
                data.extend(o.bytes());
                let mut accounts = vec![AccountMeta::new_readonly(STATE, false), AccountMeta::new(g.user, false), AccountMeta::new_readonly(g.agent.pubkey(), true)];
                accounts.extend(Env::maps());
                let agent = g.agent.insecure_clone();
                env.send(&format!("seed {seed} step {step}: grid level {k} direct"), vec![Instruction { program_id: VELOCITY, accounts, data }], &[&agent])
            };
            let refused = match &r {
                Ok(_) => events(&r).first().filter(|e| !e.accepted).map(|e| e.reason),
                Err(_) => None,
            };
            if let Some(c) = refused {
                *out.refused_by.entry(name(c)).or_default() += 1;
                if dir == 1 {
                    *out.refused_sells.entry(name(c)).or_default() += 1;
                }
                continue;
            }
            if r.is_err() {
                out.velocity_refused += 1;
                continue;
            }
            out.accepted += 1;
            let id = raw_orders(&env, &owner).iter().map(|o| o.order_id).max().expect("the order rests");
            resting[k] = Some((px, id));
            if guarded {
                // Breach check at acceptance, from raw bytes: size, exposure, leverage, notional, band, daily loss.
                day_notional += SIZE as i128 * price as i128 / BASE as i128;
                let w = worst(&env, &owner);
                let eq = equity(&env, &owner, price);
                let lev = if eq > 0 { w * price as i128 / BASE as i128 * 10_000 / eq } else { i128::MAX };
                let band = (px as i128 - price as i128).abs() * 10_000 > limits.price_band_bps as i128 * price as i128;
                let g10 = start - pre_eq > DAILY_LOSS as i128;
                let risk_up = dir == 0; // grid sells only reduce a long the grid bought
                if SIZE > limits.max_order_base
                    || w > limits.markets[0].1 as i128
                    || (risk_up && lev > limits.max_leverage_bps as i128)
                    || day_notional > limits.daily_notional_cap as i128
                    || band
                    || (risk_up && g10)
                {
                    out.breaches += 1;
                }
            }
        }
        let eq = equity(&env, &owner, price);
        min_eq = min_eq.min(eq);
        let (base, ..) = env.totals(&owner);
        out.max_position = out.max_position.max(base as f64 / 1e9);
    }
    let end = equity(&env, &owner, *prices.last().unwrap());
    out.worst_loss_pct = ((start - min_eq) as f64 / start as f64 * 100.0).max(0.0);
    out.end_loss_pct = (start - end) as f64 / start as f64 * 100.0;
    if guarded {
        let st = env.guard_state(&g);
        let on_chain: u64 = st.refused.iter().sum::<u64>() + st.refused_g10;
        let tallied: u32 = out.refused_by.values().sum();
        assert_eq!(on_chain, tallied as u64, "seed {seed}: on-chain refusal counters match the tally");
    }
    out
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 }
}

#[test]
fn sweep_grid_agent_on_30_random_paths() {
    let mut rows = vec![];
    let mut total_refused: BTreeMap<String, u32> = BTreeMap::new();
    let (mut g5_runs, mut g6_runs, mut g10_runs) = (vec![], vec![], vec![]);
    for seed in 1..=SEEDS {
        let u = run(seed, false);
        let g = run(seed, true);
        for (k, n) in &g.refused_by {
            *total_refused.entry(k.clone()).or_default() += n;
        }
        if g.refused_by.contains_key("G5 leverage") { g5_runs.push(seed); }
        if g.refused_by.contains_key("G6 price band") { g6_runs.push(seed); }
        if g.refused_by.contains_key("G10 daily loss") { g10_runs.push(seed); }
        let p = path(seed);
        rows.push((seed, *p.last().unwrap() as f64 / P0 as f64 * 100.0 - 100.0, p.iter().copied().min().unwrap() as f64 / P0 as f64 * 100.0 - 100.0, u, g));
    }
    let mut lines = vec![
        "REPLAY sweep: Velocity's devnet binary in LiteSVM, devnet state cloned Nov 21 2026; SOL prices written by the test.".to_string(),
        format!("Agent: a fixed-size grid bot (2 SOL at each 1% level below $91.39, 10 levels; after a buy it sells that 2 SOL one level up). It keeps orders within 3% of the price and never doubles. {SEEDS} seeded paths of {STEPS} steps, {:.1}% volatility a step; an order fills when the price passes through it.", SIGMA * 100.0),
        "Guard limits: G1 4 SOL, G4 30 SOL worst case, G3 100,000 dUSDT a day, G5 1.5x, G6 2% band, G10 100 dUSDT daily loss. Collateral 1,000 dUSDT.".to_string(),
        String::new(),
        format!("{:>4} {:>8} {:>8} | {:>10} {:>8} {:>6} {:>6} | {:>10} {:>8} {:>6} {:>6} {:>8} | refused by the guard", "seed", "end", "low", "unguarded", "max pos", "fills", "Vel.", "guarded", "max pos", "fills", "acc.", "breach"),
    ];
    for (seed, end, low, u, g) in &rows {
        lines.push(format!(
            "{:>4} {:>7.1}% {:>7.1}% | {:>9.1}% {:>7.0} {:>6} {:>6} | {:>9.1}% {:>7.0} {:>6} {:>6} {:>8} | {:?}",
            seed, end, low, u.worst_loss_pct, u.max_position, u.fills, u.velocity_refused, g.worst_loss_pct, g.max_position, g.fills, g.accepted, g.breaches, g.refused_by
        ));
    }
    let um = median(rows.iter().map(|r| r.3.worst_loss_pct).collect());
    let gm = median(rows.iter().map(|r| r.4.worst_loss_pct).collect());
    let uw = rows.iter().map(|r| r.3.worst_loss_pct).fold(0.0, f64::max);
    let gw = rows.iter().map(|r| r.4.worst_loss_pct).fold(0.0, f64::max);
    let breaches: u32 = rows.iter().map(|r| r.4.breaches).sum();
    let mut sells: BTreeMap<String, u32> = BTreeMap::new();
    for r in &rows {
        for (k, n) in &r.4.refused_sells {
            *sells.entry(k.clone()).or_default() += n;
        }
    }
    lines.push(String::new());
    lines.push(format!("SWEEP  worst loss, median over {SEEDS} paths: unguarded {um:.1}%, guarded {gm:.1}%. Worst single path: unguarded {uw:.1}%, guarded {gw:.1}%."));
    lines.push(format!("SWEEP  refusals by rule (all paths): {total_refused:?}; of those, the grid's sells: {sells:?}. Breaches: {breaches}."));
    lines.push(format!("SWEEP  G5 (leverage) bound on seeds {g5_runs:?}; G6 (price band) on seeds {g6_runs:?}; G10 (daily loss) on seeds {g10_runs:?}."));
    lines.push("For contrast, the runaway (martingale) replay on a path where SOL falls 12% in 14 steps is one more row, in tests/runaway.rs and notes/runaway-replay.txt; there the unguarded run was stopped only by Velocity's own 5x margin check.".to_string());
    lines.push("Breach = an accepted order over G1, G4, G3 or the band, or a risk-increasing order accepted over G5 or while the day's loss was over G10, at acceptance, measured from raw account bytes.".to_string());
    let text = lines.join("\n");
    println!("{text}");
    let _ = std::fs::create_dir_all(concat!(env!("CARGO_MANIFEST_DIR"), "/../out"));
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../out/sweep.txt"), &text).unwrap();
    let json = serde_json::json!({
        "seeds": SEEDS, "steps": STEPS, "sigma": SIGMA,
        "medianWorstLossPct": { "unguarded": um, "guarded": gm },
        "worstLossPct": { "unguarded": uw, "guarded": gw },
        "refusedBy": total_refused, "breaches": breaches,
        "g5Seeds": g5_runs, "g6Seeds": g6_runs, "g10Seeds": g10_runs,
        "rows": rows.iter().map(|(s, end, low, u, g)| serde_json::json!({
            "seed": s, "endPct": end, "lowPct": low,
            "unguarded": { "worstLossPct": u.worst_loss_pct, "maxPosition": u.max_position, "velocityRefused": u.velocity_refused },
            "guarded": { "worstLossPct": g.worst_loss_pct, "maxPosition": g.max_position, "accepted": g.accepted, "refusedBy": g.refused_by, "breaches": g.breaches },
        })).collect::<Vec<_>>(),
    });
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../out/sweep.json"), serde_json::to_string_pretty(&json).unwrap()).unwrap();
    assert_eq!(breaches, 0, "zero breaches guarded on every path");
    assert!(!g5_runs.is_empty(), "G5 binds on some paths");
    assert!(!g6_runs.is_empty(), "G6 binds on some paths");
}
