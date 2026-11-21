//! Pure limit math (STUB for the red phase: every function returns a wrong value).

pub const BASE_PRECISION: i128 = 1_000_000_000;
pub const BPS: i128 = 10_000;

/// Oracle price (with its exponent) in Velocity's PRICE_PRECISION (1e6). None on overflow or a non-positive price.
pub fn price_to_1e6(_price: i64, _exponent: i32) -> Option<i64> {
    None
}

/// G4: worst case if every open order on one side fills: max(|base + open_bids|, |base + open_asks|).
pub fn worst_case_base(_base: i64, _open_bids: i64, _open_asks: i64) -> i128 {
    0
}

/// G4: worst case after adding an order of `size` in `direction` (0 Long adds to bids, 1 Short to asks).
pub fn worst_case_after(_base: i64, _open_bids: i64, _open_asks: i64, _direction: u8, _size: u64) -> i128 {
    0
}

/// Quote value (1e6) of `base` (1e9) at `price` (1e6).
pub fn notional(_base_abs: i128, _price_1e6: i64) -> i128 {
    0
}

/// G6: |price - oracle| * 10_000 <= band_bps * oracle.
pub fn within_band(_price_1e6: i128, _oracle_1e6: i64, _band_bps: u32) -> bool {
    true
}

/// G6: |offset| * 10_000 <= band_bps * oracle.
pub fn offset_within_band(_offset_1e6: i128, _oracle_1e6: i64, _band_bps: u32) -> bool {
    true
}

/// G5: notional / equity in basis points. None if equity is not positive.
pub fn leverage_bps(_notional: i128, _equity: i128) -> Option<i128> {
    Some(0)
}

/// Spot token amount: scaled_balance * cumulative_interest / 10^(19 - decimals).
pub fn token_amount(_scaled_balance: u64, _cumulative_interest: u128, _decimals: u32) -> Option<i128> {
    Some(0)
}

/// G9: a reduce-only order opposite to the position and no larger than it.
pub fn is_exit(_reduce_only: bool, _direction: u8, _size: u64, _position_base: i64) -> bool {
    false
}

/// G3: UTC day number.
pub fn utc_day(unix: i64) -> i64 {
    unix.div_euclid(86_400)
}
