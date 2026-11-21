//! REPLAY harness: Velocity's real devnet binary in LiteSVM with devnet state cloned on Nov 21 2026. The oracle
//! accounts are rewritten at every step with a chosen price (a replay of a price path, not live data), so fills,
//! positions and PnL can be exercised. Token accounts holding test dUSDT are written directly as fixtures.

use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub type Pubkey = Address;
pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

pub const VELOCITY: Pubkey = Address::from_str_const("vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P");
pub const TOKEN: Pubkey = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SYSTEM: Pubkey = Address::from_str_const("11111111111111111111111111111111");
pub const RENT: Pubkey = Address::from_str_const("SysvarRent111111111111111111111111111111111");
pub const STATE: Pubkey = Address::from_str_const("2etx5NvPNxeMZ7EfHE6GjJfW2imRYEUANehNS1WB4CVW");
pub const SPOT0: Pubkey = Address::from_str_const("2QpHj5vzgCdWaGM2KSoGtYJWeSkx24cMyzUDHDrucvRc");
pub const PERP0: Pubkey = Address::from_str_const("FDejXbUrSy6zayBCL5xuk2SXLHZgr8ppfFTLcHbyJorY");
pub const SPOT0_VAULT: Pubkey = Address::from_str_const("G9NKtiafHiCTArgVouXx6XS7Jb3DqigrT6S6BgSDLrvz");
pub const SOL_ORACLE: Pubkey = Address::from_str_const("2k3UHX6ehRFzx5fTVvbL6FwXhMjkucjJDL9MuVKLo8TV");
pub const USDT_ORACLE: Pubkey = Address::from_str_const("Dai8hT1YRBBm5rBSJUSKcdR11psM55LVAkshbypfC4k4");
pub const QUOTE_MINT: Pubkey = Address::from_str_const("GqmEqYsy8EyvofDpmtFxK8zhYrgWgNokAtYoduQdL7v6");

pub const BASE: u64 = 1_000_000_000; // BASE_PRECISION (1 SOL)
pub const PRICE: u64 = 1_000_000; // PRICE_PRECISION ($1)
pub const QUOTE: u64 = 1_000_000; // QUOTE_PRECISION (1 dUSDT)

pub fn disc(name: &str) -> [u8; 8] {
    Sha256::digest(format!("global:{name}").as_bytes())[..8].try_into().unwrap()
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Address::find_program_address(seeds, &VELOCITY).0
}
pub fn user_pda(authority: &Pubkey) -> Pubkey {
    pda(&[b"user", authority.as_ref(), &0u16.to_le_bytes()])
}
pub fn stats_pda(authority: &Pubkey) -> Pubkey {
    pda(&[b"user_stats", authority.as_ref()])
}

fn fixture(name: &str) -> (Account, u64) {
    use base64::Engine;
    let p = format!("{}/../fixtures/devnet/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    let r = &v["result"];
    let val = &r["value"];
    let data = base64::engine::general_purpose::STANDARD.decode(val["data"][0].as_str().unwrap()).unwrap();
    let owner: Pubkey = val["owner"].as_str().unwrap().parse().unwrap();
    (
        Account { lamports: val["lamports"].as_u64().unwrap(), data, owner, executable: false, rent_epoch: 0 },
        r["context"]["slot"].as_u64().unwrap(),
    )
}

#[derive(Clone, Copy, Debug)]
pub struct Order {
    pub order_type: u8, // 0 Market, 1 Limit, 2 TriggerMarket, 3 TriggerLimit, 4 Oracle
    pub market_type: u8, // 0 Spot, 1 Perp
    pub direction: u8,  // 0 Long, 1 Short
    pub user_order_id: u8,
    pub base: u64,
    pub price: u64,
    pub market_index: u16,
    pub reduce_only: bool,
    pub post_only: u8, // 0 None, 1 MustPostOnly, 2 TryPostOnly, 3 Slide
    pub bit_flags: u8, // 1 ImmediateOrCancel
    pub trigger_price: Option<u64>,
    pub oracle_price_offset: Option<i64>,
    pub auction: Option<(u8, i64, i64)>,
    pub builder_idx: Option<u8>,
    pub builder_fee: Option<u16>,
    pub max_ts: Option<i64>,
}

impl Order {
    pub fn limit(direction: u8, base: u64, price: u64) -> Self {
        Self {
            order_type: 1, market_type: 1, direction, user_order_id: 0, base, price, market_index: 0, reduce_only: false,
            post_only: 0, bit_flags: 0, trigger_price: None, oracle_price_offset: None, auction: None, builder_idx: None,
            builder_fee: None,
            max_ts: None,
        }
    }
    /// A resting post-only limit order (what the agent uses in these replays).
    pub fn resting(direction: u8, base: u64, price: u64) -> Self {
        let mut o = Self::limit(direction, base, price);
        o.post_only = 1;
        o
    }
    pub fn bytes(&self) -> Vec<u8> {
        fn opt<const N: usize>(d: &mut Vec<u8>, v: Option<[u8; N]>) {
            match v {
                Some(b) => {
                    d.push(1);
                    d.extend_from_slice(&b);
                }
                None => d.push(0),
            }
        }
        let mut d = vec![self.order_type, self.market_type, self.direction, self.user_order_id];
        d.extend_from_slice(&self.base.to_le_bytes());
        d.extend_from_slice(&self.price.to_le_bytes());
        d.extend_from_slice(&self.market_index.to_le_bytes());
        d.push(self.reduce_only as u8);
        d.push(self.post_only);
        d.push(self.bit_flags);
        opt(&mut d, self.max_ts.map(|v| v.to_le_bytes()));
        opt(&mut d, self.trigger_price.map(|v| v.to_le_bytes()));
        d.push(0); // trigger_condition Above
        opt(&mut d, self.oracle_price_offset.map(|v| v.to_le_bytes()));
        match self.auction {
            Some((dur, start, end)) => {
                d.extend_from_slice(&[1, dur, 1]);
                d.extend_from_slice(&start.to_le_bytes());
                d.push(1);
                d.extend_from_slice(&end.to_le_bytes());
            }
            None => d.extend_from_slice(&[0, 0, 0]),
        }
        opt(&mut d, self.builder_idx.map(|v| [v]));
        opt(&mut d, self.builder_fee.map(|v| v.to_le_bytes()));
        d
    }
}

pub struct Env {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub oracle_disc: [u8; 8],
    pub usdt_oracle_disc: [u8; 8],
    pub log: Vec<String>,
    /// When set, transactions print only their label line (expected failures stay out of the output).
    pub quiet: bool,
}

fn w(k: Pubkey) -> AccountMeta {
    AccountMeta::new(k, false)
}
fn r(k: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(k, false)
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/velocity-devnet.so");
        svm.add_program_from_file(VELOCITY, so).expect("load fixtures/velocity-devnet.so");
        let mut slot0 = 0;
        for (addr, name) in [
            (STATE, "state"),
            (SPOT0, "spot0"),
            (PERP0, "perp0"),
            (SPOT0_VAULT, "spot0_vault"),
            (SOL_ORACLE, "sol_oracle"),
            (USDT_ORACLE, "usdt_oracle"),
            (QUOTE_MINT, "quote_mint"),
        ] {
            let (a, s) = fixture(name);
            slot0 = slot0.max(s);
            svm.set_account(addr, a).unwrap();
        }
        let oracle_disc = svm.get_account(&SOL_ORACLE).unwrap().data[..8].try_into().unwrap();
        let usdt_oracle_disc = svm.get_account(&USDT_ORACLE).unwrap().data[..8].try_into().unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000 * 1_000_000_000).unwrap();
        let mut env = Self { svm, payer, oracle_disc, usdt_oracle_disc, log: vec![], quiet: false };
        let mut c: Clock = env.svm.get_sysvar();
        c.slot = slot0 + 10;
        c.unix_timestamp = 1_795_230_000;
        env.svm.set_sysvar(&c);
        env
    }

    pub fn note(&mut self, s: impl Into<String>) {
        let s = s.into();
        println!("{s}");
        self.log.push(s);
    }

    /// Advances the clock by `slots` (400 ms each) and rewrites both oracles: SOL at `sol_price` ($ x 1e6) and
    /// USDT at $1, posted in the current slot with a tight confidence.
    pub fn step(&mut self, slots: u64, sol_price: u64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.slot += slots;
        c.unix_timestamp += (slots as i64 * 2) / 5;
        self.svm.set_sysvar(&c);
        self.svm.expire_blockhash();
        let (slot, ts) = (c.slot, c.unix_timestamp);
        // PythLazerOracle: price i64, publish_time u64 (microseconds), posted_slot u64, exponent i32, pad 4, conf u64.
        let write = |svm: &mut LiteSVM, at: Pubkey, d8: [u8; 8], price_e8: i64, conf_e8: u64| {
            let mut d = d8.to_vec();
            d.extend_from_slice(&price_e8.to_le_bytes());
            d.extend_from_slice(&((ts as u64) * 1_000_000).to_le_bytes());
            d.extend_from_slice(&slot.to_le_bytes());
            d.extend_from_slice(&(-8i32).to_le_bytes());
            d.extend_from_slice(&[0u8; 4]);
            d.extend_from_slice(&conf_e8.to_le_bytes());
            let mut a = svm.get_account(&at).unwrap();
            a.data = d;
            svm.set_account(at, a).unwrap();
        };
        let (d1, d2) = (self.oracle_disc, self.usdt_oracle_disc);
        write(&mut self.svm, SOL_ORACLE, d1, (sol_price * 100) as i64, 1_000_000);
        write(&mut self.svm, USDT_ORACLE, d2, 100_000_000, 10_000);
    }

    pub fn send(&mut self, label: &str, ixs: Vec<Instruction>, signers: &[&Keypair]) -> TxResult {
        let mut all = vec![solana_instruction::Instruction {
            program_id: Address::from_str_const("ComputeBudget111111111111111111111111111111"),
            accounts: vec![],
            data: { let mut d = vec![2u8]; d.extend_from_slice(&1_400_000u32.to_le_bytes()); d },
        }];
        all.extend(ixs);
        let msg = Message::new_with_blockhash(&all, Some(&self.payer.pubkey()), &self.svm.latest_blockhash());
        let mut ks: Vec<&Keypair> = vec![&self.payer];
        ks.extend_from_slice(signers);
        let tx = Transaction::new(&ks, msg, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        let (ok, logs) = match &res {
            Ok(m) => (true, m.logs.clone()),
            Err(f) => (false, f.meta.logs.clone()),
        };
        if !self.quiet {
            self.note(format!("[{label}] {}", if ok { "OK".to_string() } else { format!("FAILED {:?}", res.as_ref().err().unwrap().err) }));
        }
        let quiet = self.quiet;
        for l in logs.iter().filter(|_| !quiet) {
            if l.contains("Program log:") && !l.contains("Instruction:") && l.len() < 300 {
                self.note(format!("    {l}"));
            } else if !ok && !l.contains("consumed") {
                self.note(format!("    {l}"));
            }
        }
        res
    }

    /// A funded wallet with a Velocity user (sub-account 0) holding `dusdt` test collateral.
    pub fn trader(&mut self, label: &str, dusdt: u64) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 10 * 1_000_000_000).unwrap();
        let a = k.pubkey();
        let (user, stats) = (user_pda(&a), stats_pda(&a));
        let ix = |accounts, data| Instruction { program_id: VELOCITY, accounts, data };
        let mut name = [0u8; 32];
        name[..label.len()].copy_from_slice(label.as_bytes());
        let mut init_user = disc("initialize_user").to_vec();
        init_user.extend_from_slice(&0u16.to_le_bytes());
        init_user.extend_from_slice(&name);
        let r1 = self.send(
            &format!("{label}: initialize_user_stats + initialize_user"),
            vec![
                ix(vec![w(stats), w(STATE), r(a), AccountMeta::new(a, true), r(RENT), r(SYSTEM)], disc("initialize_user_stats").to_vec()),
                ix(vec![w(user), w(stats), w(STATE), r(a), AccountMeta::new(a, true), r(RENT), r(SYSTEM)], init_user),
            ],
            &[&k],
        );
        assert!(r1.is_ok());
        // Test dUSDT token account written directly (fixture): SPL token account layout, 165 bytes.
        let ata = Address::new_unique();
        let mut t = Vec::with_capacity(165);
        t.extend_from_slice(QUOTE_MINT.as_ref());
        t.extend_from_slice(a.as_ref());
        t.extend_from_slice(&(dusdt * QUOTE).to_le_bytes());
        t.extend_from_slice(&[0u8; 36]); // delegate None
        t.push(1); // initialized
        t.extend_from_slice(&[0u8; 12]); // is_native None
        t.extend_from_slice(&0u64.to_le_bytes());
        t.extend_from_slice(&[0u8; 36]); // close authority None
        let lamports = self.svm.minimum_balance_for_rent_exemption(165);
        self.svm.set_account(ata, Account { lamports, data: t, owner: TOKEN, executable: false, rent_epoch: 0 }).unwrap();
        let mut dep = disc("deposit").to_vec();
        dep.extend_from_slice(&0u16.to_le_bytes());
        dep.extend_from_slice(&(dusdt * QUOTE).to_le_bytes());
        dep.push(0);
        let r2 = self.send(
            &format!("{label}: deposit {dusdt} dUSDT"),
            vec![ix(
                vec![r(STATE), w(user), w(stats), AccountMeta::new_readonly(a, true), w(SPOT0_VAULT), w(ata), r(TOKEN), r(USDT_ORACLE), w(SPOT0)],
                dep,
            )],
            &[&k],
        );
        assert!(r2.is_ok());
        k
    }

    pub fn maps() -> Vec<AccountMeta> {
        vec![r(SOL_ORACLE), r(USDT_ORACLE), w(SPOT0), w(PERP0)]
    }

    pub fn place(&mut self, label: &str, k: &Keypair, o: Order) -> TxResult {
        let mut data = disc("place_perp_order").to_vec();
        data.extend(o.bytes());
        let mut accounts = vec![r(STATE), w(user_pda(&k.pubkey())), AccountMeta::new_readonly(k.pubkey(), true)];
        accounts.extend(Self::maps());
        self.send(label, vec![Instruction { program_id: VELOCITY, accounts, data }], &[k])
    }

    pub fn place_and_take(&mut self, label: &str, k: &Keypair, o: Order, makers: &[&Pubkey]) -> TxResult {
        let mut data = disc("place_and_take_perp_order").to_vec();
        data.extend(o.bytes());
        data.push(0); // success_condition None
        let a = k.pubkey();
        let mut accounts = vec![r(STATE), w(user_pda(&a)), w(stats_pda(&a)), AccountMeta::new_readonly(a, true)];
        accounts.extend(Self::maps());
        for m in makers {
            accounts.push(w(user_pda(m)));
            accounts.push(w(stats_pda(m)));
        }
        self.send(label, vec![Instruction { program_id: VELOCITY, accounts, data }], &[k])
    }

    pub fn settle_pnl(&mut self, label: &str, k: &Keypair) -> TxResult {
        let mut data = disc("settle_pnl").to_vec();
        data.extend_from_slice(&0u16.to_le_bytes());
        let mut accounts = vec![r(STATE), w(user_pda(&k.pubkey())), AccountMeta::new_readonly(k.pubkey(), true), r(SPOT0_VAULT)];
        accounts.extend(Self::maps());
        // Velocity requires the AMM to be updated in the same slot before settling (permissionless update_amms).
        let mut upd = disc("update_amms").to_vec();
        upd.extend_from_slice(&1u32.to_le_bytes());
        upd.extend_from_slice(&0u16.to_le_bytes());
        let mut ua = vec![r(STATE), AccountMeta::new_readonly(k.pubkey(), true)];
        ua.extend(Self::maps());
        self.send(label, vec![Instruction { program_id: VELOCITY, accounts: ua, data: upd }, Instruction { program_id: VELOCITY, accounts, data }], &[k])
    }

    /// Reads SpotMarket.cumulative_deposit_interest (u128 at 328) and PerpMarket margin_ratio_initial /
    /// maintenance (u32 at 616 / 620), offsets computed from Velocity's IDL and matched to the real account sizes.
    pub fn market_params(&self) -> (u128, u32, u32) {
        let s = self.svm.get_account(&SPOT0).unwrap().data;
        let p = self.svm.get_account(&PERP0).unwrap().data;
        (
            u128::from_le_bytes(s[328..344].try_into().unwrap()),
            u32::from_le_bytes(p[616..620].try_into().unwrap()),
            u32::from_le_bytes(p[620..624].try_into().unwrap()),
        )
    }

    /// Collateral, unrealized PnL, initial margin requirement and leverage computed from account fields only.
    pub fn margin_view(&self, authority: &Pubkey, price: u64) -> String {
        let u = self.user(authority);
        let (cdi, mri, mrm) = self.market_params();
        // token amount = scaled_balance * cumulative_deposit_interest / 10^(19 - decimals), decimals 6
        let collateral = (u.spot0_scaled_balance as u128 * cdi / 10u128.pow(13)) as i128;
        let (mut upnl, mut notional) = (0i128, 0i128);
        for p in &u.perp {
            let value = p.base_asset_amount as i128 * price as i128 / BASE as i128;
            upnl += value + p.quote_asset_amount as i128;
            notional += value.abs();
        }
        let init_req = notional * mri as i128 / 10_000;
        let maint_req = notional * mrm as i128 / 10_000;
        let equity = collateral + upnl;
        format!(
            "collateral {:.6} + uPnL {:.6} = equity {:.6} dUSDT; notional {:.6}; initial margin req {:.6} ({} bps), maintenance {:.6} ({} bps); leverage {:.3}x",
            collateral as f64 / 1e6, upnl as f64 / 1e6, equity as f64 / 1e6, notional as f64 / 1e6,
            init_req as f64 / 1e6, mri, maint_req as f64 / 1e6, mrm, notional as f64 / equity as f64
        )
    }

    pub fn user(&self, authority: &Pubkey) -> UserView {
        UserView::parse(&self.svm.get_account(&user_pda(authority)).unwrap().data)
    }
}

impl Default for Env {
    fn default() -> Self {
        Self::new()
    }
}

/// Fields read straight from the User account bytes (layout from velocity-v1 source, commit 25186244).
#[derive(Debug, Clone)]
pub struct UserView {
    pub spot0_scaled_balance: u64,
    pub spot0_open_orders: u8,
    pub perp: Vec<PerpView>,
    pub open_orders: Vec<OrderView>,
    pub total_deposits: u64,
    pub settled_perp_pnl: i64,
}

#[derive(Debug, Clone)]
pub struct PerpView {
    pub market_index: u16,
    pub base_asset_amount: i64,
    pub quote_asset_amount: i64,
    pub quote_break_even_amount: i64,
    pub quote_entry_amount: i64,
    pub open_bids: i64,
    pub open_asks: i64,
    pub settled_pnl: i64,
    pub open_orders: u8,
}

#[derive(Debug, Clone)]
pub struct OrderView {
    pub order_id: u32,
    pub status: u8,
    pub direction: u8,
    pub price: u64,
    pub base: u64,
    pub filled: u64,
}

impl UserView {
    pub fn parse(d: &[u8]) -> Self {
        let i64_at = |o: usize| i64::from_le_bytes(d[o..o + 8].try_into().unwrap());
        let u64_at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
        let mut perp = vec![];
        for i in 0..8 {
            let o = 424 + i * 80;
            let p = PerpView {
                base_asset_amount: i64_at(o + 8),
                quote_asset_amount: i64_at(o + 16),
                quote_break_even_amount: i64_at(o + 24),
                quote_entry_amount: i64_at(o + 32),
                open_bids: i64_at(o + 40),
                open_asks: i64_at(o + 48),
                settled_pnl: i64_at(o + 56),
                market_index: u16::from_le_bytes(d[o + 76..o + 78].try_into().unwrap()),
                open_orders: d[o + 78],
            };
            if p.base_asset_amount != 0 || p.open_orders != 0 || p.quote_asset_amount != 0 {
                perp.push(p);
            }
        }
        let mut open_orders = vec![];
        for i in 0..32 {
            let o = 1064 + i * 104;
            if d[o + 86] == 1 {
                open_orders.push(OrderView {
                    order_id: u32::from_le_bytes(d[o + 80..o + 84].try_into().unwrap()),
                    status: d[o + 86],
                    direction: d[o + 91],
                    price: u64_at(o + 8),
                    base: u64_at(o + 16),
                    filled: u64_at(o + 24),
                });
            }
        }
        let after_orders = 1064 + 32 * 104;
        UserView {
            spot0_scaled_balance: u64_at(104),
            spot0_open_orders: d[104 + 35],
            perp,
            open_orders,
            total_deposits: u64_at(after_orders),
            settled_perp_pnl: i64_at(after_orders + 24),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Guard helpers
// ---------------------------------------------------------------------------------------------------------------

pub const GUARD: Pubkey = Address::from_str_const("BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy");

/// Guard error codes (Anchor custom errors start at 6000, in declaration order).
pub mod gerr {
    pub const ORDER_TOO_LARGE: u32 = 6000;
    pub const MARKET_NOT_ALLOWED: u32 = 6001;
    pub const ORDER_TYPE_NOT_ALLOWED: u32 = 6002;
    pub const BUILDER_FIELDS_REFUSED: u32 = 6003;
    pub const DAILY_NOTIONAL_EXCEEDED: u32 = 6004;
    pub const EXPOSURE_EXCEEDED: u32 = 6005;
    pub const LEVERAGE_EXCEEDED: u32 = 6006;
    pub const PRICE_OUTSIDE_BAND: u32 = 6007;
    pub const STALE_ORACLE: u32 = 6008;
    pub const PAUSED: u32 = 6009;
    pub const NOT_OWNER: u32 = 6010;
    pub const NOT_AGENT: u32 = 6011;
    pub const AGENT_REVOKED: u32 = 6012;
    pub const NOT_PERP: u32 = 6013;
    pub const BIT_FLAGS_REFUSED: u32 = 6014;
    pub const TRIGGER_ORDERS_REFUSED: u32 = 6015;
    pub const ZERO_SIZE: u32 = 6016;
    pub const NOT_VELOCITY_USER: u32 = 6017;
    pub const NOT_USER_AUTHORITY: u32 = 6018;
    pub const BAD_MARKET_ACCOUNT: u32 = 6019;
    pub const MISSING_MARKET_ACCOUNT: u32 = 6020;
    pub const UNSUPPORTED_ORACLE: u32 = 6021;
    pub const OTHER_SPOT_BALANCE: u32 = 6022;
    pub const BAD_ORACLE_ACCOUNT: u32 = 6023;
    pub const NON_POSITIVE_EQUITY: u32 = 6024;
    pub const INVALID_LIMITS: u32 = 6025;
    pub const STALE_EXIT_UNFAVOURABLE: u32 = 6028;
    pub const CANCEL_NOT_ALLOWED: u32 = 6029;
    pub const ORDER_LIFETIME_TOO_LONG: u32 = 6030;
    pub const TOO_MANY_OPEN_ORDERS: u32 = 6031;
}

pub mod rule {
    pub const ACCEPTED: u8 = 0;
    pub const G1: u8 = 1;
    pub const G2: u8 = 2;
    pub const G3: u8 = 3;
    pub const G4: u8 = 4;
    pub const G5: u8 = 5;
    pub const G6: u8 = 6;
    pub const G7: u8 = 7;
    pub const G9: u8 = 9;
    pub const SHAPE: u8 = 10;
}

pub const T_MARKET: u8 = 1 << 0;
pub const T_LIMIT: u8 = 1 << 1;
pub const T_ORACLE: u8 = 1 << 4;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_order_base: u64,
    pub markets: [(u16, u64); 8],
    pub allowed_order_types: u8,
    pub daily_notional_cap: u64,
    pub max_leverage_bps: u32,
    pub price_band_bps: u32,
    pub max_oracle_staleness_slots: u64,
    pub exit_max_staleness_slots: u64,
    /// Non-exit orders must carry max_ts within this many seconds of now (0 = no bound).
    pub max_order_lifetime_secs: u64,
}

impl Limits {
    /// Every limit loose, so a test can tighten exactly one.
    pub fn loose() -> Self {
        let mut markets = [(0u16, 0u64); 8];
        markets[0] = (0, 1_000_000 * BASE);
        Self {
            max_order_base: 1_000_000 * BASE,
            markets,
            allowed_order_types: T_MARKET | T_LIMIT | T_ORACLE,
            daily_notional_cap: u64::MAX / 4,
            max_leverage_bps: 1_000_000,
            price_band_bps: 10_000,
            max_oracle_staleness_slots: 1_000_000,
            exit_max_staleness_slots: 2_000_000,
            max_order_lifetime_secs: 0,
        }
    }
    pub fn bytes(&self) -> Vec<u8> {
        let mut d = self.max_order_base.to_le_bytes().to_vec();
        for (idx, cap) in self.markets {
            d.extend_from_slice(&idx.to_le_bytes());
            d.extend_from_slice(&cap.to_le_bytes());
        }
        d.push(self.allowed_order_types);
        d.extend_from_slice(&self.daily_notional_cap.to_le_bytes());
        d.extend_from_slice(&self.max_leverage_bps.to_le_bytes());
        d.extend_from_slice(&self.price_band_bps.to_le_bytes());
        d.extend_from_slice(&self.max_oracle_staleness_slots.to_le_bytes());
        d.extend_from_slice(&self.exit_max_staleness_slots.to_le_bytes());
        d.extend_from_slice(&self.max_order_lifetime_secs.to_le_bytes());
        d
    }
}

pub struct Guarded {
    pub owner: Keypair,
    pub agent: Keypair,
    pub user: Pubkey,
    pub guard: Pubkey,
}

pub fn guard_pda(user: &Pubkey) -> Pubkey {
    Address::find_program_address(&[b"guard", user.as_ref()], &GUARD).0
}

#[derive(Debug, Clone)]
pub struct GuardState {
    pub owner: Pubkey,
    pub velocity_user: Pubkey,
    pub agent: Pubkey,
    pub paused: bool,
    pub day: i64,
    pub day_notional: u64,
    pub accepted_count: u64,
    /// refused[i] = orders refused by rule i (index 1..=7 used: G1..G7).
    pub refused: [u64; 8],
    pub last_refusal: LastRefusal,
    /// Order ids the guard placed (ring buffer; 0 = empty).
    pub placed_order_ids: Vec<u32>,
    pub cancel_count: u64,
    pub refused_cancels: u64,
    /// The last refusal for each rule (index = rule code 0..=7).
    pub last_refusal_by_rule: Vec<LastRefusal>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LastRefusal {
    pub rule: u8,
    pub reason: u32,
    pub value: i128,
    pub cap: i128,
    pub slot: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderEvent {
    pub guard: Pubkey,
    pub accepted: bool,
    pub rule: u8,
    pub market_index: u16,
    pub direction: u8,
    pub base: u64,
    pub reduce_only: bool,
    pub value: i128,
    pub cap: i128,
    /// The guard error code naming the reason (0 when accepted).
    pub reason: u32,
}

/// Decodes OrderChecked events from a transaction's logs (also present in failed transactions).
pub fn events(r: &TxResult) -> Vec<OrderEvent> {
    use base64::Engine;
    let logs = match r {
        Ok(m) => &m.logs,
        Err(f) => &f.meta.logs,
    };
    let d8: [u8; 8] = Sha256::digest(b"event:OrderChecked")[..8].try_into().unwrap();
    let mut out = vec![];
    for l in logs {
        if let Some(b) = l.strip_prefix("Program data: ") {
            let d = base64::engine::general_purpose::STANDARD.decode(b).unwrap_or_default();
            if d.len() >= 8 + 32 + 1 + 1 + 2 + 1 + 8 + 1 + 16 + 16 + 4 && d[..8] == d8 {
                let mut o = 8;
                let guard = Address::new_from_array(d[o..o + 32].try_into().unwrap());
                o += 32;
                let accepted = d[o] == 1;
                let rule = d[o + 1];
                let market_index = u16::from_le_bytes(d[o + 2..o + 4].try_into().unwrap());
                let direction = d[o + 4];
                let base = u64::from_le_bytes(d[o + 5..o + 13].try_into().unwrap());
                let reduce_only = d[o + 13] == 1;
                let value = i128::from_le_bytes(d[o + 14..o + 30].try_into().unwrap());
                let cap = i128::from_le_bytes(d[o + 30..o + 46].try_into().unwrap());
                let reason = u32::from_le_bytes(d[o + 46..o + 50].try_into().unwrap());
                out.push(OrderEvent { guard, accepted, rule, market_index, direction, base, reduce_only, value, cap, reason });
            }
        }
    }
    out
}

/// The custom error code of a failed transaction (panics with logs otherwise).
pub fn code(r: &TxResult) -> u32 {
    use solana_instruction_error::InstructionError;
    use solana_transaction_error::TransactionError;
    match r {
        Ok(m) => panic!("expected a refusal, got success. logs:\n{}", m.logs.join("\n")),
        Err(f) => match &f.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) => *c,
            other => panic!("expected a custom error, got {other:?}. logs:\n{}", f.meta.logs.join("\n")),
        },
    }
}

#[track_caller]
pub fn assert_code(r: &TxResult, c: u32) {
    assert_eq!(code(r), c, "wrong error code");
}

/// A recorded refusal: the transaction SUCCEEDS, Velocity is not called, and the event names the reason.
#[track_caller]
pub fn assert_refused(r: &TxResult, reason: u32) -> OrderEvent {
    assert_ok(r);
    let ev = events(r);
    assert_eq!(ev.len(), 1, "one OrderChecked event");
    assert!(!ev[0].accepted, "event says refused");
    assert_eq!(ev[0].reason, reason, "refusal reason");
    if let Ok(m) = r {
        assert!(!m.logs.iter().any(|l| l.contains("Program vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P invoke")), "Velocity is not called on a refusal");
    }
    ev[0].clone()
}

#[track_caller]
pub fn assert_ok(r: &TxResult) {
    if let Err(f) = r {
        panic!("expected success, got {:?}. logs:\n{}", f.err, f.meta.logs.join("\n"));
    }
}

impl Env {
    pub fn add_guard_program(&mut self) {
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy/guard.so");
        self.svm.add_program_from_file(GUARD, so).expect("load target/deploy/guard.so (build it first)");
    }

    pub fn init_guard_ix(owner: &Pubkey, agent: &Pubkey, limits: &Limits) -> Instruction {
        let user = user_pda(owner);
        let mut data = disc("init_guard").to_vec();
        data.extend_from_slice(agent.as_ref());
        data.extend(limits.bytes());
        Instruction {
            program_id: GUARD,
            accounts: vec![AccountMeta::new(*owner, true), r(user), w(guard_pda(&user)), r(SYSTEM)],
            data,
        }
    }

    pub fn delegate_ix(owner: &Pubkey, delegate: &Pubkey) -> Instruction {
        let mut data = disc("update_user_delegate").to_vec();
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(delegate.as_ref());
        Instruction { program_id: VELOCITY, accounts: vec![w(user_pda(owner)), AccountMeta::new_readonly(*owner, true)], data }
    }

    /// Owner with a Velocity account holding `dusdt`, a guard with `limits`, the guard set as delegate.
    pub fn guarded(&mut self, dusdt: u64, limits: Limits) -> Guarded {
        let owner = self.trader("owner", dusdt);
        let agent = Keypair::new();
        self.svm.airdrop(&agent.pubkey(), 1_000_000_000).unwrap();
        let user = user_pda(&owner.pubkey());
        let guard = guard_pda(&user);
        let r = self.send(
            "owner: init_guard + update_user_delegate -> guard",
            vec![Self::init_guard_ix(&owner.pubkey(), &agent.pubkey(), &limits), Self::delegate_ix(&owner.pubkey(), &guard)],
            &[&owner],
        );
        assert_ok(&r);
        Guarded { owner, agent, user, guard }
    }

    fn trade_accounts(signer: &Pubkey, g: &Guarded, extra: &[AccountMeta]) -> Vec<AccountMeta> {
        let mut a = vec![
            AccountMeta::new_readonly(*signer, true),
            w(g.guard),
            r(STATE),
            w(g.user),
            r(VELOCITY),
        ];
        if extra.is_empty() {
            a.extend(Self::maps());
        } else {
            a.extend_from_slice(extra);
        }
        a
    }

    /// The agent places an order through the guard (default remaining accounts: SOL and USDT oracles, spot0, perp0).
    pub fn gplace(&mut self, label: &str, g: &Guarded, o: Order) -> TxResult {
        self.gplace_as(label, g, &g.agent.insecure_clone(), o, &[])
    }

    pub fn gplace_as(&mut self, label: &str, g: &Guarded, signer: &Keypair, o: Order, extra: &[AccountMeta]) -> TxResult {
        let mut data = disc("place_perp_order").to_vec();
        data.extend(o.bytes());
        let accounts = Self::trade_accounts(&signer.pubkey(), g, extra);
        self.send(label, vec![Instruction { program_id: GUARD, accounts, data }], &[signer])
    }

    pub fn gcancel(&mut self, label: &str, g: &Guarded, order_id: Option<u32>) -> TxResult {
        let mut data = disc("cancel_order").to_vec();
        match order_id {
            Some(id) => {
                data.push(1);
                data.extend_from_slice(&id.to_le_bytes());
            }
            None => data.push(0),
        }
        let agent = g.agent.insecure_clone();
        let accounts = Self::trade_accounts(&agent.pubkey(), g, &[]);
        self.send(label, vec![Instruction { program_id: GUARD, accounts, data }], &[&agent])
    }

    fn owner_ix(name: &str, signer: &Pubkey, g: &Guarded, args: Vec<u8>) -> Instruction {
        let mut data = disc(name).to_vec();
        data.extend(args);
        Instruction { program_id: GUARD, accounts: vec![AccountMeta::new_readonly(*signer, true), w(g.guard)], data }
    }

    pub fn set_limits(&mut self, label: &str, g: &Guarded, signer: &Keypair, l: &Limits) -> TxResult {
        let ix = Self::owner_ix("set_limits", &signer.pubkey(), g, l.bytes());
        self.send(label, vec![ix], &[signer])
    }
    pub fn set_agent(&mut self, label: &str, g: &Guarded, signer: &Keypair, agent: &Pubkey) -> TxResult {
        let ix = Self::owner_ix("set_agent", &signer.pubkey(), g, agent.as_ref().to_vec());
        self.send(label, vec![ix], &[signer])
    }
    pub fn set_paused(&mut self, label: &str, g: &Guarded, signer: &Keypair, paused: bool) -> TxResult {
        let ix = Self::owner_ix("set_paused", &signer.pubkey(), g, vec![paused as u8]);
        self.send(label, vec![ix], &[signer])
    }

    pub fn guard_state(&self, g: &Guarded) -> GuardState {
        let d = self.svm.get_account(&g.guard).expect("guard exists").data;
        let key = |o: usize| Address::new_from_array(d[o..o + 32].try_into().unwrap());
        // 8 disc, owner 32, velocity_user 32, agent 32, paused 1, limits (8 + 8*10 + 1 + 8 + 4 + 4 + 8 + 8 + 8 = 129), day, day_notional
        let o = 8 + 96 + 1 + 129;
        // then bump 1, accepted_count u64, refused_g1..g7 7 x u64, last_refusal {rule u8, reason u32, value i128, cap i128, slot u64}
        let u64_at = |x: usize| u64::from_le_bytes(d[x..x + 8].try_into().unwrap());
        let c = o + 16 + 1;
        let mut refused = [0u64; 8];
        for (i, r) in refused.iter_mut().enumerate().skip(1) {
            *r = u64_at(c + 8 + (i - 1) * 8);
        }
        let lr = c + 8 + 7 * 8;
        let read_lr = |x: usize| LastRefusal {
            rule: d[x],
            reason: u32::from_le_bytes(d[x + 1..x + 5].try_into().unwrap()),
            value: i128::from_le_bytes(d[x + 5..x + 21].try_into().unwrap()),
            cap: i128::from_le_bytes(d[x + 21..x + 37].try_into().unwrap()),
            slot: u64_at(x + 37),
        };
        // after last_refusal (45 bytes): placed_order_ids [u32; 32], placed_cursor u8, cancel_count u64,
        // refused_cancels u64, last_refusal_by_rule [LastRefusal; 8]
        let p = lr + 45;
        let placed_order_ids = (0..32).map(|i| u32::from_le_bytes(d[p + i * 4..p + i * 4 + 4].try_into().unwrap())).filter(|x| *x != 0).collect();
        let q = p + 128 + 1;
        let by = q + 16;
        GuardState {
            placed_order_ids,
            cancel_count: u64_at(q),
            refused_cancels: u64_at(q + 8),
            last_refusal_by_rule: (0..8).map(|i| read_lr(by + i * 45)).collect(),
            owner: key(8),
            velocity_user: key(40),
            agent: key(72),
            paused: d[104] == 1,
            day: i64::from_le_bytes(d[o..o + 8].try_into().unwrap()),
            day_notional: u64_at(o + 8),
            accepted_count: u64_at(c),
            refused,
            last_refusal: LastRefusal {
                rule: d[lr],
                reason: u32::from_le_bytes(d[lr + 1..lr + 5].try_into().unwrap()),
                value: i128::from_le_bytes(d[lr + 5..lr + 21].try_into().unwrap()),
                cap: i128::from_le_bytes(d[lr + 21..lr + 37].try_into().unwrap()),
                slot: u64_at(lr + 37),
            },
        }
    }

    /// A flow account crosses the agent's resting orders with a large IOC place_and_take (AMM liquidity down to the
    /// limit fills first, then the agent's order). Returns the change in the agent's base position.
    pub fn cross(&mut self, label: &str, flow: &Keypair, g: &Guarded, direction: u8, size: u64, limit: u64) -> i64 {
        let before = self.user(&g.owner.pubkey()).perp.iter().filter(|p| p.market_index == 0).map(|p| p.base_asset_amount).sum::<i64>();
        let o = Order::limit(direction, size, limit);
        let owner = g.owner.pubkey();
        let r = self.place_and_take(label, flow, o, &[&owner]);
        assert_ok(&r);
        let after = self.user(&g.owner.pubkey()).perp.iter().filter(|p| p.market_index == 0).map(|p| p.base_asset_amount).sum::<i64>();
        after - before
    }

    /// Market-0 totals of the guarded account, read from raw bytes (independent of the guard's code).
    pub fn totals(&self, owner: &Pubkey) -> (i64, i64, i64, i64) {
        let u = self.user(owner);
        let mut t = (0, 0, 0, 0);
        for p in u.perp.iter().filter(|p| p.market_index == 0) {
            t.0 += p.base_asset_amount;
            t.1 += p.quote_asset_amount;
            t.2 += p.open_bids;
            t.3 += p.open_asks;
        }
        t
    }

    pub fn has_open_order(&self, owner: &Pubkey, base: u64, price: u64) -> bool {
        self.user(owner).open_orders.iter().any(|o| o.base == base && o.price == price)
    }
}


impl Env {
    /// Advances the clock without rewriting the oracles (to age them).
    pub fn advance(&mut self, slots: u64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.slot += slots;
        c.unix_timestamp += (slots as i64 * 2) / 5;
        self.svm.set_sysvar(&c);
        self.svm.expire_blockhash();
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    /// Collateral (spot 0 deposit in quote units) read from raw bytes, independent of the guard.
    pub fn raw_collateral(&self, owner: &Pubkey) -> i128 {
        let u = self.user(owner);
        let (cdi, _, _) = self.market_params();
        (u.spot0_scaled_balance as u128 * cdi / 10u128.pow(13)) as i128
    }
}

impl Env {
    /// Cancels all of a trader's orders directly on Velocity (probe helper).
    pub fn gcancel_raw(&mut self, k: &Keypair) -> TxResult {
        let mut data = disc("cancel_orders").to_vec();
        data.extend_from_slice(&[0, 0, 0]);
        let mut accounts = vec![AccountMeta::new_readonly(STATE, false), AccountMeta::new(user_pda(&k.pubkey()), false), AccountMeta::new_readonly(k.pubkey(), true)];
        accounts.extend(Self::maps());
        self.send("cancel all (raw)", vec![Instruction { program_id: VELOCITY, accounts, data }], &[k])
    }
}

impl Env {
    pub fn slot_now(&self) -> u64 {
        self.svm.get_sysvar::<Clock>().slot
    }
}


// ---------------------------------------------------------------------------------------------------------------
// Audit helpers: raw order slots and a keeper fill
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct RawOrder {
    pub order_id: u32,
    pub status: u8,
    pub order_type: u8,
    pub direction: u8,
    pub reduce_only: bool,
    pub price: u64,
    pub base: u64,
    pub filled: u64,
    pub auction_start: i64,
    pub auction_end: i64,
    pub auction_duration: u8,
    pub oracle_price_offset: i64,
    pub user_order_id: u8,
    pub max_ts: i64,
}

/// Open orders read straight from the User account (User + 1064 + i*104).
pub fn raw_orders(env: &Env, owner: &Pubkey) -> Vec<RawOrder> {
    let d = env.svm.get_account(&user_pda(owner)).unwrap().data;
    let u64_at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
    let i64_at = |o: usize| i64::from_le_bytes(d[o..o + 8].try_into().unwrap());
    (0..32)
        .map(|i| 1064 + i * 104)
        .filter(|o| d[o + 86] == 1)
        .map(|o| RawOrder {
            price: u64_at(o + 8),
            base: u64_at(o + 16),
            filled: u64_at(o + 24),
            auction_start: i64_at(o + 48),
            auction_end: i64_at(o + 56),
            oracle_price_offset: i64_at(o + 72),
            order_id: u32::from_le_bytes(d[o + 80..o + 84].try_into().unwrap()),
            status: d[o + 86],
            order_type: d[o + 87],
            user_order_id: d[o + 89],
            direction: d[o + 91],
            reduce_only: d[o + 92] == 1,
            auction_duration: d[o + 96],
            max_ts: i64_at(o + 64),
        })
        .collect()
}

impl Env {
    /// A keeper fills `order_id` of `taker_owner` against `makers` with Velocity's fill_perp_order.
    pub fn fill_order(&mut self, label: &str, filler: &Keypair, taker_owner: &Pubkey, order_id: u32, makers: &[&Pubkey]) -> TxResult {
        let mut data = disc("fill_perp_order").to_vec();
        data.push(1);
        data.extend_from_slice(&order_id.to_le_bytes());
        data.push(0);
        let f = filler.pubkey();
        let mut accounts = vec![
            AccountMeta::new_readonly(STATE, false),
            AccountMeta::new_readonly(f, true),
            AccountMeta::new(user_pda(&f), false),
            AccountMeta::new(stats_pda(&f), false),
            AccountMeta::new(user_pda(taker_owner), false),
            AccountMeta::new(stats_pda(taker_owner), false),
        ];
        accounts.extend(Self::maps());
        for m in makers {
            accounts.push(AccountMeta::new(user_pda(m), false));
            accounts.push(AccountMeta::new(stats_pda(m), false));
        }
        self.send(label, vec![Instruction { program_id: VELOCITY, accounts, data }], &[filler])
    }

    /// The id of the most recent open order the guard placed (for cancels by id).
    pub fn last_guard_order(&self, g: &Guarded) -> Option<u32> {
        let placed = self.guard_state(g).placed_order_ids;
        raw_orders(self, &g.owner.pubkey()).iter().map(|o| o.order_id).filter(|id| placed.contains(id)).max()
    }
}
