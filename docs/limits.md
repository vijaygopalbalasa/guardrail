# The limits in full

Back to the [README](../README.md).

## The limits

| | Limit | In one line |
|---|---|---|
| G0 | Setup and agent | Only the Velocity account's owner can create its guard, and only the agent key the owner named can trade through it; a revoked or different key is rejected. |
| G1 | Order size | No single order larger than the owner's maximum. |
| G2 | Allowlists | Only the owner's markets and order types (Limit, Market, Oracle); no trigger orders, no builder fees, no odd order flags. |
| G3 | Daily notional | Total order value per UTC day stays under the cap; a new day starts a new total. |
| G4 | Worst-case exposure | Position plus every open order on one side plus this order stays under the cap for that market. A true exit (it opposes the position and, with every order already resting on that side, fits inside it) is not checked, so an order that only shrinks the position is never trapped; a flip past flat is checked. |
| G5 | Leverage | Worst-case notional across the account, over collateral plus unrealized PnL, stays under the cap. Like G4 and G10, it waives only true exits. |
| G6 | Price band | Every price on the order stays within a band around the market's own oracle, and the oracle must be fresh. |
| G7 | Owner controls | Only the owner sets limits, rotates or revokes the agent, and pauses. |
| G8 | No withdraw | The guard has no withdraw path and reaches only Velocity's place and cancel instructions. |
| G9 | Exits and cancels | Cancels always go through; an exit that only shrinks the position (counting only the guard's own resting exits) skips G1 to G5, G10 and the pause but stays inside the band and the order lifetime, and with a very stale oracle it may only be priced in the owner's favour. A reduce-only order beyond the position is refused. |
| G10 | Daily loss brake (stops new risk, does not close positions) | The owner sets the most the account may lose in one UTC day. The day's baseline (collateral plus unrealized PnL) is the higher of the equity at the guard's first call that UTC day and the last equity the guard saw (adjusted for deposits and withdrawals since), so waiting for a low does not help. Every guard call, cancels included, must bring the accounts that price the account (a missing one fails the call), so the agent cannot choose which calls are seen; only a stale oracle skips the reading. A cap needs a keeper (`set_keeper`; the owner's own key is fine): `node scripts/keeper.mjs --keypair <keeper.json> --owners <owner> --at-midnight` checkpoints just after each 00:00 UTC, which marks the day at the equity then (only the owner or its keeper gets that mark; anyone else's checkpoint uses the max rule). Without a midnight mark the baseline never falls: a new day starts at the highest equity known for the last day seen, so losses carry over until the keeper (or the owner) marks a day. A missing account fails a call; a stale or unsupported oracle only skips the reading, so cancels and exits still go through. Once the loss since then passes the cap, only exits and cancels go through until the next UTC day. Deposits and withdrawals in between are taken out (Velocity values them at the quote oracle, so to within the stablecoin's distance from $1), so neither hides nor fakes a loss. |

Upgrades: the Guard account has 128 reserved bytes for future fields. A guard made by an older program version (865, 950, 967 or 999 bytes) is
grown with the owner-only `migrate_guard` (the owner pays the extra rent; a migrated guard that has a daily loss cap must
then name a keeper with `set_keeper`, and the dashboard warns until it does); older guards close and start again; `close_guard` returns the rent and lets
`init_guard` run again. Closing does not touch Velocity: the owner removes the guard as delegate with Velocity's
`update_user_delegate` before trading directly.

A refused order is a successful transaction that records the rule, the measured value and the owner's cap, and
emits an `OrderChecked` event. Nothing reaches Velocity. Real errors (wrong agent, bad accounts, a stale oracle on a
new order, Velocity's own errors) still fail.
