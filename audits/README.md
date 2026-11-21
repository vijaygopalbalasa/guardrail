# Review rounds

Four internal security review rounds on the guard program, each run from a clean copy of the repository against
Velocity's real devnet binary (REPLAY in LiteSVM). They are not a professional audit. Every finding has a red-first
test, a fix and a planted bug in the repository; the fixes are logged round by round in `notes/RED.md`.

| Round | Report | Findings (highest first) |
|---|---|---|
| 1 | `round-1.md` | F1 High (Oracle order with no worst price), F2 to F4 Medium/Low, INFO |
| 2 | `round-2.md` | N1 High (flip past flat), N2 to N4 Medium, N5 Low |
| 3 | `round-3.md` | R3-1 Medium (older guards bricked by layout growth), R3-2 Low to Medium (baseline timing) |
| 4 | `round-4.md` | Low and Info only (migration lengths, baseline residuals, keeper retries) |
