//! Velocity v1 constants and read-only views of its accounts, by layout. Offsets come from Velocity's IDL
//! (velocity-v1 commit 25186244) and were matched to the real devnet account sizes (User 4496, PerpMarket 1560,
//! SpotMarket 1064, PythLazerOracle 48).

use anchor_lang::prelude::*;

pub const PROGRAM_ID: Pubkey = pubkey!("vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P");

/// sha256("global:<name>")[..8]
pub const IX_PLACE_PERP_ORDER: [u8; 8] = [69, 161, 93, 202, 120, 126, 76, 185];
pub const IX_CANCEL_ORDER: [u8; 8] = [95, 129, 237, 240, 8, 49, 223, 132];

/// sha256("account:<name>")[..8]
pub const DISC_USER: [u8; 8] = [0x9f, 0x75, 0x5f, 0xe3, 0xef, 0x97, 0x3a, 0xec];
pub const DISC_PERP_MARKET: [u8; 8] = [0x0a, 0xdf, 0x0c, 0x2c, 0x6b, 0xf5, 0x37, 0xf7];
pub const DISC_SPOT_MARKET: [u8; 8] = [0x64, 0xb1, 0x08, 0x6b, 0xa8, 0x41, 0x41, 0x27];
pub const DISC_PYTH_LAZER_ORACLE: [u8; 8] = [0x9f, 0x07, 0xa1, 0xf9, 0x22, 0x51, 0x79, 0x85];

pub const USER_LEN: usize = 4496;
pub const PERP_MARKET_LEN: usize = 1560;
pub const SPOT_MARKET_LEN: usize = 1064;
pub const ORACLE_LEN: usize = 48;

/// OracleSource::PythLazer. Other sources (with 1K/1M multipliers or stablecoin rules) are refused.
pub const ORACLE_SOURCE_PYTH_LAZER: u8 = 12;

// User
pub const USER_AUTHORITY: usize = 8;
pub const USER_DELEGATE: usize = 40;
pub const USER_SPOT_POSITIONS: usize = 104; // 8 x 40
pub const SPOT_POSITION_LEN: usize = 40;
pub const USER_PERP_POSITIONS: usize = 424; // 8 x 80
pub const PERP_POSITION_LEN: usize = 80;
pub const NUM_POSITIONS: usize = 8;

// PerpMarket
pub const PERP_ORACLE: usize = 312;
pub const PERP_MARKET_INDEX: usize = 640;
pub const PERP_ORACLE_SOURCE: usize = 673;

// SpotMarket
pub const SPOT_CUMULATIVE_DEPOSIT_INTEREST: usize = 328;
pub const SPOT_CUMULATIVE_BORROW_INTEREST: usize = 344;
pub const SPOT_DECIMALS: usize = 696;
pub const SPOT_MARKET_INDEX: usize = 700;

fn i64_at(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn u16_at(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(d[o..o + 2].try_into().unwrap())
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PerpPos {
    pub market_index: u16,
    pub base: i64,
    pub quote: i64,
    pub open_bids: i64,
    pub open_asks: i64,
    pub open_orders: u8,
}

impl PerpPos {
    pub fn is_active(&self) -> bool {
        self.base != 0 || self.quote != 0 || self.open_bids != 0 || self.open_asks != 0 || self.open_orders != 0
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpotPos {
    pub market_index: u16,
    pub scaled_balance: u64,
    /// 0 Deposit, 1 Borrow
    pub balance_type: u8,
}

/// One open order slot (User + 1064 + i*104).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OrderSlot {
    pub order_id: u32,
    pub market_index: u16,
    pub order_type: u8,
    pub direction: u8,
    pub reduce_only: bool,
    pub price: u64,
    pub base: u64,
    pub filled: u64,
    pub auction_start: i64,
    pub auction_end: i64,
    pub oracle_price_offset: i64,
    pub auction_duration: u8,
    /// Expiry (unix seconds); 0 = never.
    pub max_ts: i64,
}

pub const USER_ORDERS: usize = 1064;
/// total_deposits, then total_withdraws (probe_deposit_and_withdraw_totals).
pub const USER_TOTAL_DEPOSITS: usize = 4392;
pub const ORDER_LEN: usize = 104;
pub const NUM_ORDERS: usize = 32;

pub struct UserView {
    pub authority: Pubkey,
    pub delegate: Pubkey,
    pub perp: [PerpPos; NUM_POSITIONS],
    pub spot: [SpotPos; NUM_POSITIONS],
    /// Open orders only (status Open).
    pub orders: Vec<OrderSlot>,
    /// Velocity's running totals of deposits and withdrawals (quote units at the quote oracle price).
    pub total_deposits: u64,
    pub total_withdraws: u64,
}

impl UserView {
    /// Checks owner, discriminator and size, then reads the fields the guard needs.
    pub fn load(acc: &AccountInfo) -> Option<UserView> {
        if *acc.owner != PROGRAM_ID {
            return None;
        }
        let d = acc.try_borrow_data().ok()?;
        if d.len() < USER_LEN || d[..8] != DISC_USER {
            return None;
        }
        Some(Self::parse(&d))
    }

    pub fn parse(d: &[u8]) -> UserView {
        let mut perp = [PerpPos::default(); NUM_POSITIONS];
        let mut spot = [SpotPos::default(); NUM_POSITIONS];
        for (i, p) in perp.iter_mut().enumerate() {
            let o = USER_PERP_POSITIONS + i * PERP_POSITION_LEN;
            *p = PerpPos {
                base: i64_at(d, o + 8),
                quote: i64_at(d, o + 16),
                open_bids: i64_at(d, o + 40),
                open_asks: i64_at(d, o + 48),
                market_index: u16_at(d, o + 76),
                open_orders: d[o + 78],
            };
        }
        for (i, s) in spot.iter_mut().enumerate() {
            let o = USER_SPOT_POSITIONS + i * SPOT_POSITION_LEN;
            *s = SpotPos { scaled_balance: u64_at(d, o), market_index: u16_at(d, o + 32), balance_type: d[o + 34] };
        }
        let mut orders = vec![];
        for i in 0..NUM_ORDERS {
            let o = USER_ORDERS + i * ORDER_LEN;
            if d[o + 86] != 1 {
                continue;
            }
            orders.push(OrderSlot {
                price: u64_at(d, o + 8),
                base: u64_at(d, o + 16),
                filled: u64_at(d, o + 24),
                auction_start: i64_at(d, o + 48),
                auction_end: i64_at(d, o + 56),
                max_ts: i64_at(d, o + 64),
                oracle_price_offset: i64_at(d, o + 72),
                order_id: u32::from_le_bytes(d[o + 80..o + 84].try_into().unwrap()),
                market_index: u16_at(d, o + 84),
                order_type: d[o + 87],
                direction: d[o + 91],
                reduce_only: d[o + 92] == 1,
                auction_duration: d[o + 96],
            });
        }
        UserView {
            authority: Pubkey::try_from(&d[USER_AUTHORITY..USER_AUTHORITY + 32]).unwrap(),
            delegate: Pubkey::try_from(&d[USER_DELEGATE..USER_DELEGATE + 32]).unwrap(),
            perp,
            spot,
            orders,
            total_deposits: u64_at(d, USER_TOTAL_DEPOSITS),
            total_withdraws: u64_at(d, USER_TOTAL_DEPOSITS + 8),
        }
    }

    /// Sums every active slot for the market (an empty slot also reads market_index 0, so sum, never first-match).
    pub fn perp_totals(&self, market_index: u16) -> PerpPos {
        let mut t = PerpPos { market_index, ..Default::default() };
        for p in self.perp.iter().filter(|p| p.is_active() && p.market_index == market_index) {
            t.base += p.base;
            t.quote += p.quote;
            t.open_bids += p.open_bids;
            t.open_asks += p.open_asks;
            t.open_orders = t.open_orders.saturating_add(p.open_orders);
        }
        t
    }

    /// Unfilled size of the open reduce-only orders on one side of a market (for G9 stacking).
    pub fn resting_reduce_only(&self, market_index: u16, direction: u8) -> u64 {
        self.orders
            .iter()
            .filter(|o| o.reduce_only && o.market_index == market_index && o.direction == direction)
            .map(|o| o.base.saturating_sub(o.filled))
            .sum()
    }

    /// Distinct markets with an active perp slot.
    pub fn active_markets(&self) -> Vec<u16> {
        let mut v: Vec<u16> = vec![];
        for p in self.perp.iter().filter(|p| p.is_active()) {
            if !v.contains(&p.market_index) {
                v.push(p.market_index);
            }
        }
        v
    }
}

pub fn perp_market_address(market_index: u16) -> Pubkey {
    Pubkey::find_program_address(&[b"perp_market", &market_index.to_le_bytes()], &PROGRAM_ID).0
}

pub fn spot_market_address(market_index: u16) -> Pubkey {
    Pubkey::find_program_address(&[b"spot_market", &market_index.to_le_bytes()], &PROGRAM_ID).0
}

pub struct PerpMarketView {
    pub oracle: Pubkey,
    pub oracle_source: u8,
}

pub fn load_perp_market(acc: &AccountInfo, market_index: u16) -> Option<PerpMarketView> {
    if *acc.owner != PROGRAM_ID || *acc.key != perp_market_address(market_index) {
        return None;
    }
    let d = acc.try_borrow_data().ok()?;
    if d.len() < PERP_MARKET_LEN || d[..8] != DISC_PERP_MARKET || u16_at(&d, PERP_MARKET_INDEX) != market_index {
        return None;
    }
    Some(PerpMarketView {
        oracle: Pubkey::try_from(&d[PERP_ORACLE..PERP_ORACLE + 32]).unwrap(),
        oracle_source: d[PERP_ORACLE_SOURCE],
    })
}

pub struct SpotMarketView {
    pub cumulative_deposit_interest: u128,
    pub cumulative_borrow_interest: u128,
    pub decimals: u32,
}

pub fn load_spot_market(acc: &AccountInfo, market_index: u16) -> Option<SpotMarketView> {
    if *acc.owner != PROGRAM_ID || *acc.key != spot_market_address(market_index) {
        return None;
    }
    let d = acc.try_borrow_data().ok()?;
    if d.len() < SPOT_MARKET_LEN || d[..8] != DISC_SPOT_MARKET || u16_at(&d, SPOT_MARKET_INDEX) != market_index {
        return None;
    }
    Some(SpotMarketView {
        cumulative_deposit_interest: u128::from_le_bytes(d[SPOT_CUMULATIVE_DEPOSIT_INTEREST..SPOT_CUMULATIVE_DEPOSIT_INTEREST + 16].try_into().unwrap()),
        cumulative_borrow_interest: u128::from_le_bytes(d[SPOT_CUMULATIVE_BORROW_INTEREST..SPOT_CUMULATIVE_BORROW_INTEREST + 16].try_into().unwrap()),
        decimals: u32::from_le_bytes(d[SPOT_DECIMALS..SPOT_DECIMALS + 4].try_into().unwrap()),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OracleView {
    pub price: i64,
    pub posted_slot: u64,
    pub exponent: i32,
}

/// PythLazerOracle: 8 discriminator, price i64, publish_time u64, posted_slot u64, exponent i32, pad 4, conf u64.
pub fn load_oracle(acc: &AccountInfo) -> Option<OracleView> {
    if *acc.owner != PROGRAM_ID {
        return None;
    }
    let d = acc.try_borrow_data().ok()?;
    if d.len() < ORACLE_LEN || d[..8] != DISC_PYTH_LAZER_ORACLE {
        return None;
    }
    Some(OracleView {
        price: i64_at(&d, 8),
        posted_slot: u64_at(&d, 24),
        exponent: i32::from_le_bytes(d[32..36].try_into().unwrap()),
    })
}
