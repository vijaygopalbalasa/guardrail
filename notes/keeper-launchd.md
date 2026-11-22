# Daily keeper for the demo guards (launchd, this Mac, until judging ends Dec 20 2026)

The dashboard shows each guard's last keeper checkpoint and warns after 26 hours. To keep the four demo guards on devnet
marked every UTC day, a user-level launchd agent runs `scripts/keeper-daily.sh` at 05:30 IST (00:00 UTC) and again at
06:00 IST (00:30 UTC). The script waits 60 s (the chain's clock trails the wall clock slightly), then runs
`scripts/keeper.mjs --now` once per owner key, because each demo guard's keeper is its own owner:

| Guard | Owner | Key file (gitignored, passed by path only) |
|---|---|---|
| 9NJpRGSq... language-model agent | FkQfmTpR... | out/demo-owner-FkQfmTpR.json |
| HMwVJCoz... scripted runaway agent | 4cMEVdWk... | out/demo-owner-4cMEVdWk.json |
| 9yVPGMcC... runaway agent, earlier run | W7ntzEnk... | out/demo-owner-W7ntzEnk.json |
| FuoawFpm... quickstart | AFnLPrDA... | keys/stranger.json (its keeper was set to the owner on Nov 22, tx 5dT8GrVr...) |

Log: `out/keeper-daily.log` (owner public keys and transaction signatures only; no key is printed). launchd's own
output goes to `out/keeper-launchd.log`. If the Mac is asleep at 05:30 IST, launchd runs the job when it wakes.

Installed Nov 22 2026:

    cp scripts/launchd/com.guardrail.keeper.plist ~/Library/LaunchAgents/
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.guardrail.keeper.plist

Tested once with `launchctl kickstart gui/$(id -u)/com.guardrail.keeper`: exit 0, all four guards checkpointed
(`notes/keeper-daily-first-run.txt`).

Check it: `launchctl print gui/$(id -u)/com.guardrail.keeper | grep -E "state|last exit"` and `tail out/keeper-daily.log`.

## Remove it after Dec 20 2026

    launchctl bootout gui/$(id -u)/com.guardrail.keeper
    rm ~/Library/LaunchAgents/com.guardrail.keeper.plist

Without the daily marks, the dashboard's keeper line turns into its 26-hour warning and each guard's daily loss brake
counts from the highest equity seen since the last mark (docs/limits.md).
