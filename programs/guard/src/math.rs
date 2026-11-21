//! Pure limit math. All intermediate values are i128 so no input in range can overflow.

pub const BASE_PRECISION: i128 = 1_000_000_000;
pub const BPS: i128 = 10_000;

/// Oracle price (with its exponent) in Velocity's PRICE_PRECISION (1e6). None on overflow or a non-positive price.
pub fn price_to_1e6(price: i64, exponent: i32) -> Option<i64> {
    if price <= 0 || !(-18..=18).contains(&exponent) {
        return None;
    }
    let shift = exponent + 6;
    let p = price as i128;
    let v = if shift >= 0 { p.checked_mul(10i128.pow(shift as u32))? } else { p / 10i128.pow((-shift) as u32) };
    if v <= 0 {
        return None;
    }
    i64::try_from(v).ok()
}

/// G4: worst case if every open order on one side fills: max(|base + open_bids|, |base + open_asks|).
/// open_asks is negative or zero in Velocity's accounting.
pub fn worst_case_base(base: i64, open_bids: i64, open_asks: i64) -> i128 {
    let (b, bids, asks) = (base as i128, open_bids as i128, open_asks as i128);
    (b + bids).abs().max((b + asks).abs())
}

/// G4: worst case after adding an order of `size` in `direction` (0 Long adds to bids, 1 Short to asks).
pub fn worst_case_after(base: i64, open_bids: i64, open_asks: i64, direction: u8, size: u64) -> i128 {
    let (b, mut bids, mut asks) = (base as i128, open_bids as i128, open_asks as i128);
    if direction == 0 {
        bids += size as i128;
    } else {
        asks -= size as i128;
    }
    (b + bids).abs().max((b + asks).abs())
}

/// Quote value (1e6) of `base` (1e9) at `price` (1e6).
pub fn notional(base_abs: i128, price_1e6: i64) -> i128 {
    base_abs * price_1e6 as i128 / BASE_PRECISION
}

/// G6: |price - oracle| * 10_000 <= band_bps * oracle.
pub fn within_band(price_1e6: i128, oracle_1e6: i64, band_bps: u32) -> bool {
    (price_1e6 - oracle_1e6 as i128).abs() * BPS <= band_bps as i128 * oracle_1e6 as i128
}

/// G6: |offset| * 10_000 <= band_bps * oracle.
pub fn offset_within_band(offset_1e6: i128, oracle_1e6: i64, band_bps: u32) -> bool {
    offset_1e6.abs() * BPS <= band_bps as i128 * oracle_1e6 as i128
}

/// G5: notional / equity in basis points (rounded up). None if equity is not positive.
pub fn leverage_bps(notional: i128, equity: i128) -> Option<i128> {
    if equity <= 0 {
        return None;
    }
    Some((notional * BPS + equity - 1) / equity)
}

/// Spot token amount: scaled_balance * cumulative_interest / 10^(19 - decimals).
pub fn token_amount(scaled_balance: u64, cumulative_interest: u128, decimals: u32) -> Option<i128> {
    if decimals > 19 {
        return None;
    }
    let v = (scaled_balance as u128).checked_mul(cumulative_interest)? / 10u128.pow(19 - decimals);
    i128::try_from(v).ok()
}

/// G9: a reduce-only order opposite to the position whose size, plus the reduce-only orders already resting on
/// that side, is no larger than the position.
pub fn is_exit(reduce_only: bool, direction: u8, size: u64, position_base: i64, resting_exits: u64) -> bool {
    if !reduce_only || size == 0 || position_base == 0 {
        return false;
    }
    let opposes = (position_base > 0 && direction == 1) || (position_base < 0 && direction == 0);
    opposes && (size as u128 + resting_exits as u128) <= position_base.unsigned_abs() as u128
}

/// G3: UTC day number.
pub fn utc_day(unix: i64) -> i64 {
    unix.div_euclid(86_400)
}

#[cfg(test)]
mod props {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig { cases: 20_000, .. ProptestConfig::default() })]

        #[test]
        fn every_true_exit_is_recognised(dir in 0u8..2, pos_abs in 1i64..i64::MAX, frac in 1u64..=1_000) {
            let pos = if dir == 1 { pos_abs } else { -pos_abs };
            let size = ((pos_abs as u128 * frac as u128) / 1_000).max(1) as u64;
            prop_assert!(is_exit(true, dir, size, pos, 0));
            prop_assert!(!is_exit(true, dir, size, pos, pos_abs as u64 - size + 1), "resting exits count");
        }

        #[test]
        fn worst_case_is_at_least_the_position_and_grows_with_order_size(
            base in any::<i64>(), bids in 0i64..i64::MAX, asks in i64::MIN + 1..=0i64, dir in 0u8..2, a in any::<u64>(), b in any::<u64>()
        ) {
            let w = worst_case_base(base, bids, asks);
            prop_assert!(w >= (base as i128).abs(), "worst case is never below the position itself");
            let (small, large) = (a.min(b), a.max(b));
            prop_assert!(worst_case_after(base, bids, asks, dir, small) <= worst_case_after(base, bids, asks, dir, large));
            prop_assert_eq!(worst_case_after(base, bids, asks, dir, 0), w);
        }

        #[test]
        fn worst_case_matches_a_brute_force_definition(base in -1_000_000i64..1_000_000, bids in 0i64..1_000_000, asks in -1_000_000i64..=0, dir in 0u8..2, size in 0u64..1_000_000) {
            let (nb, na) = if dir == 0 { (bids + size as i64, asks) } else { (bids, asks - size as i64) };
            let expect = (base + nb).abs().max((base + na).abs()) as i128;
            prop_assert_eq!(worst_case_after(base, bids, asks, dir, size), expect);
        }

        #[test]
        fn band_is_symmetric_and_exact_at_the_edge(oracle in 1i64..1_000_000_000_000, band in 1u32..10_000, d in 0i128..1_000_000_000_000) {
            prop_assert_eq!(within_band(oracle as i128 + d, oracle, band), within_band(oracle as i128 - d, oracle, band));
            let edge = (band as i128 * oracle as i128) / BPS;
            prop_assert!(within_band(oracle as i128 + edge, oracle, band));
            prop_assert!(!within_band(oracle as i128 + edge + 1, oracle, band), "one unit past the edge is refused");
            prop_assert!(!within_band(oracle as i128 - edge - 1, oracle, band));
            prop_assert_eq!(offset_within_band(d, oracle, band), within_band(oracle as i128 + d, oracle, band));
        }

        #[test]
        fn leverage_never_understates(notional in 0i128..1_000_000_000_000_000, equity in 1i128..1_000_000_000_000_000) {
            let l = leverage_bps(notional, equity).unwrap();
            prop_assert!(l * equity >= notional * BPS);
            prop_assert!((l - 1) * equity < notional * BPS || l == 0);
        }

        #[test]
        fn non_positive_equity_has_no_leverage(notional in 0i128..1_000_000_000, equity in -1_000_000_000i128..=0) {
            prop_assert!(leverage_bps(notional, equity).is_none());
        }

        #[test]
        fn exit_never_exceeds_or_follows_the_position(reduce in any::<bool>(), dir in 0u8..2, size in any::<u64>(), pos in any::<i64>()) {
            if is_exit(reduce, dir, size, pos, 0) {
                prop_assert!(reduce);
                prop_assert!(size as u128 <= pos.unsigned_abs() as u128);
                prop_assert!((pos > 0 && dir == 1) || (pos < 0 && dir == 0));
                // after a full fill the position keeps its sign or reaches zero
                let after = pos as i128 + if dir == 0 { size as i128 } else { -(size as i128) };
                prop_assert!(after == 0 || after.signum() == (pos as i128).signum());
            }
        }

        #[test]
        fn price_conversion_scales_exactly(price in 1i64..1_000_000_000_000, expo in -12i32..=-6) {
            let v = price_to_1e6(price, expo);
            let expect = price as i128 / 10i128.pow((-6 - expo) as u32);
            if expect > 0 { prop_assert_eq!(v, Some(expect as i64)); } else { prop_assert_eq!(v, None); }
        }

        #[test]
        fn notional_is_monotonic(a in 0i128..1_000_000_000_000_000, b in 0i128..1_000_000_000_000_000, p in 1i64..10_000_000_000) {
            let (lo, hi) = (a.min(b), a.max(b));
            prop_assert!(notional(lo, p) <= notional(hi, p));
            prop_assert_eq!(notional(BASE_PRECISION, p), p as i128, "1 base unit of 1e9 is worth the price");
        }
    }

    #[test]
    fn known_values() {
        assert_eq!(price_to_1e6(9_139_000_000, -8), Some(91_390_000));
        assert_eq!(worst_case_base(1_000_000_000, 500_000_000, 0), 1_500_000_000);
        assert_eq!(worst_case_after(1_000_000_000, 0, 0, 1, 3_100_000_000), 2_100_000_000);
        assert_eq!(notional(1_000_000_000, 91_390_000), 91_390_000);
        assert!(within_band(90_480_000, 91_390_000, 100));
        assert!(!within_band(90_470_000, 91_390_000, 100));
        assert_eq!(leverage_bps(3_000, 1_000), Some(30_000));
        assert_eq!(token_amount(999_999_976_700, 10_000_000_232, 6), Some(999_999_999));
        assert!(is_exit(true, 1, 1, 5, 0) && !is_exit(true, 0, 1, 5, 0) && !is_exit(true, 1, 6, 5, 0) && !is_exit(false, 1, 1, 5, 0));
        assert!(is_exit(true, 1, 2, 5, 3) && !is_exit(true, 1, 3, 5, 3));
        assert_eq!(utc_day(86_399), 0);
        assert_eq!(utc_day(-1), -1);
    }
}
