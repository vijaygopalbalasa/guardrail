# Devnet receipts

Guardrail's guard program on Solana devnet, built from commit 494359f (program code unchanged since b779468; on Nov 22 only the crate's one-line description and doc comment changed, and a rebuild gives the same bytes, sha256 05eecf83..., MATCH), after five review rounds (audits/).
Freshness check relaxed on devnet: Velocity's devnet oracle is weeks old, so the demo guards set oracle staleness to 100,000,000 slots
and their orders rest without filling. Fills at moving prices are shown on a local surfpool fork (docs/build-and-test.md).

- Program: [BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy](https://explorer.solana.com/address/BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy?cluster=devnet), built from commit 494359f; deployed bytes match the build (sha256 05eecf83..., trailing zero padding stripped; scripts/verify-devnet-program.sh, notes/devnet-guard-so.sha256)
- Deploy: [4oDHiksbeYdS2F6f...](https://explorer.solana.com/tx/4oDHiksbeYdS2F6fDW5qmGrFfCEfupx9P4HoV7sEL8BMuvAPLiCuir2VxiT1jPba17c7hY4SCWVzstjSCZcgQvEu?cluster=devnet) (final upgrade in place, Nov 22; same program id; program account extended to 384,000 bytes first)
- Earlier upgrades: audit round 4 [53b78oUuvuGiWfCG...](https://explorer.solana.com/tx/53b78oUuvuGiWfCG6RAWqJJ8RpJ3QcJBdbn2UWg3VtHxEpwPF4KJNkHsB248xuuni54ND9Sf8pjqzmnx3MQ4x6rQ?cluster=devnet), keeper review [67gAKeDjb5BxMTQg...](https://explorer.solana.com/tx/67gAKeDjb5BxMTQgSy3ntX7gFCjwyZQSZ2DhiZEZS9MVvaidBSh5Q5tvmjDSKTbsME8XcYwYD1mAFJEeWjJnvE38?cluster=devnet), strict observation [3KJqKwYppJVwfHDq...](https://explorer.solana.com/tx/3KJqKwYppJVwfHDqCJoAzG6xBtkQti29AFSepjBj9dFkV4joDwQrW23cCGZj8VXNn2z3GZeHqTFSTnGxfLfXd9XZ?cluster=devnet), audit round 2 [53pydz8dEqPa12xx...](https://explorer.solana.com/tx/53pydz8dEqPa12xxVRHmLSURHDoF6MZCYXRHvn7HG2qmRbLQTWzBEjE9UhcKQ5KNg8YENY2qmpRUGpT8c3ng2s2C?cluster=devnet), first-call baseline [P6hr1PaMyMvV6DNZ...](https://explorer.solana.com/tx/P6hr1PaMyMvV6DNZNJyT4NEi3RzbkqouUodY3ShrffjNSHuidXthL81WmshkHU7mfHi27PeZczravpPPVSkYZnr?cluster=devnet), G10 [664VGAmNMAg67SuM...](https://explorer.solana.com/tx/664VGAmNMAg67SuM7KT4rJEGZphonZCCVNSuYYaSP9wK6SXKgpSk4iwZ2kpTpK8ReRYNwzgekpGPXLb7jwm8rFgi?cluster=devnet), R5 fixes [61kwLX5YuAKCh949...](https://explorer.solana.com/tx/61kwLX5YuAKCh9498rNqJM1PzB5D8vaS25rdyGsZGUsC3ePEH4QrhwBMCYsjLu73oe3qrMYWZaQkrJLvuN9zumq8?cluster=devnet)
- IDL on chain (Nov 22, `anchor idl init`, authority 2E1Uv3nQ...): IDL account [CUNnWYCxKj5BzDt8b9cfEEpAPY62RMCKrgdhARPo2mHz](https://explorer.solana.com/address/CUNnWYCxKj5BzDt8b9cfEEpAPY62RMCKrgdhARPo2mHz?cluster=devnet), about 0.05 SOL. The explorer now names the guard's instructions, e.g. "Guard: Place Perp Order" with the account names Agent, Guard, Velocity State, Velocity User ([a G6 refusal](https://explorer.solana.com/tx/HXrysJopirVr3dTpodZ2HDXKrY47a57ab4RmZCUKdQGDbMiq2tJRr4VSMCp7By5KHkwKGHVe7WCitGk7Lu9WW8K?cluster=devnet); `docs/explorer-decoded.png`).
- First deploy with the audit fixes: [4c2TQWreEgks7ocw...](https://explorer.solana.com/tx/4c2TQWreEgks7ocw9fr8Hkd2dggPtvoLeAJupWBYTw5yHszuR96ENoPdGXvR7CzpqcexxjCrVxJ3Www2n2CxnTZC?cluster=devnet)
- migrate_guard on devnet: the quickstart guard FuoawFpm8adnPo9cU5YNTUEwH3PMHSFswmmSfjE33brG grew from 950 to 1,135 bytes [4w1Azcz2LLqqsj56...](https://explorer.solana.com/tx/4w1Azcz2LLqqsj56rneiLCc8F7xJomFDyRPgEouBXxWkdNtQzmyAhk4WvXouSkAbyYK2VW5pHCcAhwB2dNogeMux?cluster=devnet), then its owner's checkpoint loaded it [2yKH1ZdssHsqRQoK...](https://explorer.solana.com/tx/2yKH1ZdssHsqRQoKSp4mdAAtzWVmySSeb55oPojJDAFZLhPZTMNH9zqyRDSW4qH6PpsQcsPiTfgCxKSyA9Cx7fz8?cluster=devnet). The earlier demo guards' throwaway owner keys were not kept, so they stay on their old layout (history only); demo/setup.mjs now keeps the owner key in out/.
- Keeper run (scripts/keeper.mjs --now, notes/keeper-run.txt): [2CE14aqXf6sXqv2z...](https://explorer.solana.com/tx/2CE14aqXf6sXqv2zxbYsLkQGUmaL6uktXJRtqc15kMV87vnYhfZr8iKYbY29QNzCvSakAw9nTCkZEcNFjB46m2ZH?cluster=devnet) and [33U4Ez4zHB1RZ99J...](https://explorer.solana.com/tx/33U4Ez4zHB1RZ99JyVr4ZqgszDmP9gEy2RzhkraoFYo4z2YYGHXCSfAaYqM2ZZFuGvdejjHPdK41mPXCGGeH4tgk?cluster=devnet); after the final upgrade the owner's checkpoint (an owner reset, emitting a Checkpointed event) on the language-model guard [56ToYbqv1QhaoAfx...](https://explorer.solana.com/tx/56ToYbqv1QhaoAfxqEKStiRkVTY5iEB6nCrYJ4TBxkMw9dpKzKnFDfB6h272PXiqJ4LsKqG1zsY3PV3GFRrFXw6R?cluster=devnet)

## The agent tried to go around the guard

`node demo/bypass-attempt.mjs` (clip: research footage `bypass-attempt.mp4`). The language-model agent's own key
(4Cxm3yCrcX1fRkHG6U2Xry4zCqjVP5YEbHMDeFqVLabF) calls Velocity directly, skipping Guardrail, on the account guarded by
9NJpRGSqi7eKz6jSPTmcW5fZc4z8aNipSQDvWuViS9E8 (Velocity account HvburY4fpBK4BjYr4m3exS9pP5A8TnSRybAUEhio5idG). Each
transaction was sent with preflight skipped, so the failure is on chain. Afterwards the account's delegate is still the
guard and its deposits and withdrawals are unchanged. Cost: three fees, 15,000 lamports.

- (a) place a 20 SOL perp order on the owner's account: [3R6bp6TxN4SuXUMG...](https://explorer.solana.com/tx/3R6bp6TxN4SuXUMGkrMPf5mk36EDsZr5oR5pzREVtjM9QCbWtdU5mCQYEoDxDZbHdp12qc3YYfF9yMM36D5zeKAa?cluster=devnet)
  `Program log: Instruction: PlacePerpOrder` / `AnchorError caused by account: user. Error Code: ConstraintRaw. Error Number: 2003.`
  Velocity takes orders on this account only from its owner or its delegate, and the delegate is the guard.
- (b) withdraw 100 dUSDT to its own token account: [MeqydoxZ7vN3P1RT...](https://explorer.solana.com/tx/MeqydoxZ7vN3P1RTP7RRvWGSCjSmnfUos2jF3HVgungvWp7ZqfFzgTeT4hHjoKEk4v3GkC3VTW2itHCKoQyf6P3?cluster=devnet)
  `Program log: Instruction: Withdraw` / `AnchorError caused by account: user. Error Code: ConstraintHasOne. Error Number: 2001.`
  The account's authority is the owner; Velocity's withdraw is `has_one = authority`, and the guard has no withdraw path.
- (c) make itself the delegate: [2MuwW1j9gLr1dJJV...](https://explorer.solana.com/tx/2MuwW1j9gLr1dJJVsxizxWCGfW2AuVYV9WwhbXTXPiuBLTd34X3hJe7WqNUjtoszCDGhK8X7hkpCnJxhTSm6ugiQ?cluster=devnet)
  `Program log: Instruction: UpdateUserDelegate` / `AnchorError caused by account: user. Error Code: ConstraintSeeds. Error Number: 2006.`
  The account's address is derived from the owner's key, so the agent's key cannot name it.
- The same three, first run: [2yBxVnshChqMSjTa...](https://explorer.solana.com/tx/2yBxVnshChqMSjTa8cVZNMwBsvjUyA9XbTjjZ6EtZPE9PHJrS55EjWQc7qyyMJ8jGotJL4zmnXdGshSoXom2Ef3Z?cluster=devnet), [51VVfay7m1zngoCJ...](https://explorer.solana.com/tx/51VVfay7m1zngoCJqUQEGo5dG1QFJTEvs7cYkZ37bzy9JWQwV9ZdWHmEwVcJAdwHjwZCh3TXdnxGjcRqPmha6m5M?cluster=devnet), [42eZQB9bHZEuSjmi...](https://explorer.solana.com/tx/42eZQB9bHZEuSjmiFq71TUgrhPbJ8aiXmne4fu95q5is9BFBSuTtTsCaxWnyVFSM957aLEq2mFX4j8XErdcQfLGr?cluster=devnet)

## Guard HMwVJCozmVJ2qL992oFnWTKetXNgtSYbbRqyExEMC3qg (scripted runaway agent, fresh guard, Nov 22; current program, keeper set)

- Guard account: [HMwVJCozmVJ2qL992oFnWTKetXNgtSYbbRqyExEMC3qg](https://explorer.solana.com/address/HMwVJCozmVJ2qL992oFnWTKetXNgtSYbbRqyExEMC3qg?cluster=devnet); owner 4cMEVdWkpaMWvuGznBxUWeRxYXadiR5ULVmsJ2dZSH2V
- `node demo/devnet-runaway.mjs`: the runaway agent of the replay (doubling a losing long, bidding lower each step) through guardrail-mcp, with the demo limits (G1 4 SOL, G3 1,200 dUSDT a day, G4 6 SOL, G5 2x, G6 2%, G10 50 dUSDT). Orders rest; devnet's oracle is stale, so nothing fills.
- 37 orders: 6 accepted, 31 refused on chain (G1 10, G3 3, G4 3, G6 15). Dashboard: [this guard](https://guardrail-perps.vercel.app/?rpc=https://api.devnet.solana.com&guard=HMwVJCozmVJ2qL992oFnWTKetXNgtSYbbRqyExEMC3qg). Log: `notes/devnet-runaway.txt`.

- accepted: [9Fcpeaczi8ag8G3u...](https://explorer.solana.com/tx/9Fcpeaczi8ag8G3uRE6WRRCBN7Te5zT5Ggjs84pzDbbr6KcY19BEM5r9Dw1XTPvBEMHSUMXZHDCMxgAa7cJCguc?cluster=devnet)
- accepted: [2HSt7wRQNB13pQwT...](https://explorer.solana.com/tx/2HSt7wRQNB13pQwTq3ZavwW8agKhW5oh9qA3XMdcps8bhj2cJM78BSZ19MunPiWWtmnE5wonbpdMavUtBB7FUiXf?cluster=devnet)
- accepted: [32yb3cLw4CQQayQ9...](https://explorer.solana.com/tx/32yb3cLw4CQQayQ97qTddwZoQSCUsrZpbizv73FoXi296jiz1WcWUeYY4KXmRMJaZKKHnRhECbQWtEtCmRME6rv6?cluster=devnet)
- refused by G4 exposure (ExposureExceeded), 7.5 SOL vs 6: [DMrTFFL9Htop5WQm...](https://explorer.solana.com/tx/DMrTFFL9Htop5WQm9YvDDXo8GBZ5HdtXh52FHRNjYwXcR4DyfhyzzFcJyUBuyhWhKA1ygaQtdBuf2E4cDmeLiuv?cluster=devnet)
- accepted: [4mxKS9DhFqyaYRBB...](https://explorer.solana.com/tx/4mxKS9DhFqyaYRBBhxFdPpr3DqNurVyhxKh2HRCsPXkv3BW8xgnV3deHiiACUcR59ZxqG9mejJoTWnXc7h6qR8UC?cluster=devnet)
- refused by G1 order size (OrderTooLarge), 8 SOL vs 4: [3WQ6eg9zGG63nyGv...](https://explorer.solana.com/tx/3WQ6eg9zGG63nyGvQB7zVDnEQQvRbxgRsVn5F8RsWznzqoohZvkDr2Sm63Q6Xo3kzibSfPPuSMVnqX91BiDCeS2Q?cluster=devnet)
- refused by G4 exposure (ExposureExceeded), 9.5 SOL vs 6: [3SBobpzPmB2bbeKe...](https://explorer.solana.com/tx/3SBobpzPmB2bbeKeU9V4t9vhXhUHvwKifhqmbLYrbW43qnUFzkkAbqoih1Cff5NM6dvBBwm3z3EzdQFMVSr8yaiE?cluster=devnet)
- accepted: [65LNQQbZKTgKjfC1...](https://explorer.solana.com/tx/65LNQQbZKTgKjfC14F1y5Pq2UwAtmkKZSVQrJAUmgbhgatrT1SYdhCRAsrXpLXkNRmSgkVrrS8YKCgw46eZ1GfaP?cluster=devnet)
- refused by G3 daily notional (DailyNotionalExceeded), 1416.61 vs 1200 dUSDT: [25VUr6V5t1iRabyo...](https://explorer.solana.com/tx/25VUr6V5t1iRabyoCkaTFqAaVBakE9dzfk2pQXaR4MxacxnAidkUTpJv6TYMUR3FWB3eE7FHf4axesABcJFa56vc?cluster=devnet)
- refused by G3 daily notional (DailyNotionalExceeded), 1233.82 vs 1200 dUSDT: [4W7uasqmghHiW4P4...](https://explorer.solana.com/tx/4W7uasqmghHiW4P4cqPQByBVaHAxggeXboCpQ3pBnT3u5Nq9maBsvn3P2CVTRM6DcbWEv6ETJFSKRtSaacap8WPJ?cluster=devnet)
- refused by G4 exposure (ExposureExceeded), 6.5 SOL vs 6: [3kEBXpkzaM7vwRx4...](https://explorer.solana.com/tx/3kEBXpkzaM7vwRx4jmBKa58rEdauUs3VbmeDih6zJEUptvBUXtquSuTb61acezVUEtxbZopj6JE3D62twVAkQ6o8?cluster=devnet)
- accepted: [5CJ1BdhPwpzK7kYV...](https://explorer.solana.com/tx/5CJ1BdhPwpzK7kYVNHmnxYSLTVP7rCowP59JvJYD7PQVramZgbuC3VtuCuZt2xTjJQT1z3y9a11j33iWK4KLFAZf?cluster=devnet)
- refused by G3 daily notional (DailyNotionalExceeded), 1233.82 vs 1200 dUSDT: [4dfyCN5hp4FmDnX2...](https://explorer.solana.com/tx/4dfyCN5hp4FmDnX2wWsCVWawFVZchd2BHvRCJWtJbu5yZLCpfAgr8wmZChaNkEvNGe48coeCiHxad4eT9fNeud9K?cluster=devnet)
- refused by G1 order size (OrderTooLarge), 16 SOL vs 4: [25PFVetrwEnQb65m...](https://explorer.solana.com/tx/25PFVetrwEnQb65mpu7WpH1ehjfdN3ZYyEfYYmS2EKN7CkM78jV215zUyvTicjLwbW1xDNDPBfd8HwEPh4REEq8N?cluster=devnet)
- refused by G1 order size (OrderTooLarge), 8 SOL vs 4: [3ko2zk6xbT5oJHK9...](https://explorer.solana.com/tx/3ko2zk6xbT5oJHK994L83dhXkX76RPKTK2b3GR7wdyCShHLmUuGvQNLXGKXcz6LYwBKcoE9ArP1ZJ4nyLFQbYZf?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.08% vs 2.00%: [UmqdHjDWP2594kgh...](https://explorer.solana.com/tx/UmqdHjDWP2594kghkHLE36EFsekqB7P4BgNJ4DSKJyhJfaQCXL8WjTonpzzn6zzSK6KR8FYziebXWtri1RhELry?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.08% vs 2.00%: [Uei8Jcw14z1CZrrj...](https://explorer.solana.com/tx/Uei8Jcw14z1CZrrjh6kZgvWrSNyGxnECpqLBe4otHbdVBzZU374Ucw3pHUut8b1RN8PLd65E36BmbwAMuRpeQEa?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.08% vs 2.00%: [5fuW4R8yfwymVXWd...](https://explorer.solana.com/tx/5fuW4R8yfwymVXWdkt8TnYauWRA7aZhwPqxhHBBRyHy8DiUK7y9XAR6W6ude6xWE9wsuyh9auJs85sAwRokDHsiV?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.08% vs 2.00%: [2ffsmuTd7m8c6NhC...](https://explorer.solana.com/tx/2ffsmuTd7m8c6NhCUG5f89pDTLE5uLU8wepV5MJCEiaaYhiAHVPLJmCCRXKx8oVN6kqjWGfUUYwncFtDRA2TbaGv?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.08% vs 2.00%: [2EBZQvfJkcMx5YEt...](https://explorer.solana.com/tx/2EBZQvfJkcMx5YEtiUZezhTLsuRmEa7rXNYW5EbF7sbqVTezNZ5oDcgfa9g3qfkhuaT2DBpC3wbvZU3Eexk9M7sM?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.08% vs 2.00%: [5nn7ZEzzzhGn3tXD...](https://explorer.solana.com/tx/5nn7ZEzzzhGn3tXDiwXicEC8ndrpSt5igP7mM6eCeMMZ5jTxbUUaXS99jENunnw8mcgY1iRu6pNJjBnscxx2HBwt?cluster=devnet)
- refused by G1 order size (OrderTooLarge), 32 SOL vs 4: [3qjuXzEfvSy4MEXJ...](https://explorer.solana.com/tx/3qjuXzEfvSy4MEXJnoXjiCvxe6jrz2SGubPxuRoJ6fnoruHQPsDBMLtiEUwcvvSAtX4W8GE2GkzM8hSYKcv9ZXVN?cluster=devnet)
- refused by G1 order size (OrderTooLarge), 16 SOL vs 4: [3mc8562mdsijmP7g...](https://explorer.solana.com/tx/3mc8562mdsijmP7gPij8PqZqggpmEVjqjyro3upiggwhEDn8jrcFm5jbPXKZNjZkFqSdNtz42FbLjpMqhr2zNtcz?cluster=devnet)
- refused by G1 order size (OrderTooLarge), 8 SOL vs 4: [4h2FQNrDDnAMhoX8...](https://explorer.solana.com/tx/4h2FQNrDDnAMhoX8XKLsfvXz2h9dw3JSqWBGVMzV4QNnJrxMCUsdbjQwSwsVi1cB8UnDzGNzxiTR9pusXpXo9b3g?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.41% vs 2.00%: [3QbStYUrPdexgdAA...](https://explorer.solana.com/tx/3QbStYUrPdexgdAA1xKHPQjqbBuYjrrvyWvWsxboV7E5gRGwYWUyeGhBp91MRRPSABN2Bm3vFcRycCvC9EVPWijS?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.41% vs 2.00%: [2weATqeQDYAQPWUJ...](https://explorer.solana.com/tx/2weATqeQDYAQPWUJLj2hnCogAYum7iwEoUeDCo2b4mZBzVLFEyS8aFeE6MrcXiETw1ixPLSQdjxtUadaQf7rxXVJ?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.41% vs 2.00%: [HXrysJopirVr3dTp...](https://explorer.solana.com/tx/HXrysJopirVr3dTpodZ2HDXKrY47a57ab4RmZCUKdQGDbMiq2tJRr4VSMCp7By5KHkwKGHVe7WCitGk7Lu9WW8K?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.41% vs 2.00%: [217EUpxuBagGy8ef...](https://explorer.solana.com/tx/217EUpxuBagGy8efFSy3xyNqozWC5MZy2iu4cJErSXiTzoFzzGW7J6ftqVeXvGbWsUVyc1iNKtphmZpKaGev7c36?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.41% vs 2.00%: [4fig7YBLHRxmFxLj...](https://explorer.solana.com/tx/4fig7YBLHRxmFxLjnwt15H5M2YEeBdENVL6TCP1bPRnR1TEL5N4vbetxWPRYfgoEw2XLU4j2U8jh2cW87JSyUHvt?cluster=devnet)
- refused by G1 order size (OrderTooLarge), 64 SOL vs 4: [3FnqSUdkHdwa3rpi...](https://explorer.solana.com/tx/3FnqSUdkHdwa3rpiMGmcVbpGvwujhznjgKMSn2vBwqu9WMaQxv2fH5iMKrgfpP4KtNTczGVh8frhorG6REabTBM1?cluster=devnet)
- refused by G1 order size (OrderTooLarge), 32 SOL vs 4: [mc39FYDTEKduHxSN...](https://explorer.solana.com/tx/mc39FYDTEKduHxSNLWQ4qRvN3YNzKTXmcs4t3YMoKSYfGG8enPKAPocVozHWUn2pyaFwi84SSoprbrsWQAhS8Wr?cluster=devnet)
- refused by G1 order size (OrderTooLarge), 16 SOL vs 4: [5ec8FTauCMU5Ej7Q...](https://explorer.solana.com/tx/5ec8FTauCMU5Ej7QGs4dUaXzDgUFxfpReBCxLqAbTdXAGfhUtcVzrG6epGwKPCWYdwipVy8MzEjJDdAt2s6Fp4dS?cluster=devnet)
- refused by G1 order size (OrderTooLarge), 8 SOL vs 4: [4ZEXYpjGqT3kjxJN...](https://explorer.solana.com/tx/4ZEXYpjGqT3kjxJNU8JfMbSCrZ4yFHUMyPCSsm6u6vMUD1bZqDM9SesfXD6jgP4D149KA2VZL8SsCGF7rNQ45T2o?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.73% vs 2.00%: [4Kxuz3ytSdebjv7d...](https://explorer.solana.com/tx/4Kxuz3ytSdebjv7dTtTQMw1v4RxqrUwHFAzwy1jUNduGTaDiccgs7A76V92sCadnCnCCjhtYrL547NiKDB8D3hT?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.73% vs 2.00%: [48m5v22SbUVKYWa7...](https://explorer.solana.com/tx/48m5v22SbUVKYWa77peNKbFhvh7z5g7ynE5pv3VnxWPkYx8xZCcygWtgfegLEGMzbMB9MP1RQQnuR7cg92xWZYdR?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.73% vs 2.00%: [36kvNPq36udosFBA...](https://explorer.solana.com/tx/36kvNPq36udosFBA7Jdahbf72PqzDQgQWGo7frjwNxMoQE5caMEpob9CiaSHmuuq6REKZJ8bizhpghkP1u4CWB3U?cluster=devnet)
- refused by G6 price band (PriceOutsideBand), 2.73% vs 2.00%: [kvHhP1yzuauc1bh2...](https://explorer.solana.com/tx/kvHhP1yzuauc1bh2UqkgQMcYDPWFZkWbPMnQSVUTJ1kLFQGtfRb2RX6RztywQ1nmfQ6mbP3dqaVg4MGZmNc1F8g?cluster=devnet)

## Guard 9NJpRGSqi7eKz6jSPTmcW5fZc4z8aNipSQDvWuViS9E8 (language-model agent, current program (keeper set))

- Guard account: [9NJpRGSqi7eKz6jSPTmcW5fZc4z8aNipSQDvWuViS9E8](https://explorer.solana.com/address/9NJpRGSqi7eKz6jSPTmcW5fZc4z8aNipSQDvWuViS9E8?cluster=devnet); owner FkQfmTpReWXHHCoAc7vUmesKBDMSAwmx1GobETVeUMeS
- init_guard + delegate: [3qrA9mhUrE6hA8hn...](https://explorer.solana.com/tx/3qrA9mhUrE6hA8hnFPgRRZ8ongQytEofYWp8dvNT8H1WDTD2nEbmHz5UDAJkQPiD2xP1C9uNWGwFPSCNqAZkk3cm?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [3bDT1mTeCPsNVeV1...](https://explorer.solana.com/tx/3bDT1mTeCPsNVeV1VcYqcZnZAiuhqzJ6H5956wvqysEGxTbVWaX3vUc3retj53YuUhWAcqFX6Lu7v2KaVyeVnF6D?cluster=devnet)
- accepted order: [3Aut3cc37zQGkY1C...](https://explorer.solana.com/tx/3Aut3cc37zQGkY1ChUuPwDTBMkdB4o1cVVABrmFUt5sjdHfPvwFzdsiFNFBg3Ac6EqwQsuuehQ9Hoe5u53hdcVg8?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [2hrGQ3N5Va8tSjkQ...](https://explorer.solana.com/tx/2hrGQ3N5Va8tSjkQ3PguPeb69jGvuFxGMmGVRw4LE7nkQ7EWynpshsbLLZ7gpGhhEUWLVQCVvb18x5NGVC7xSdPi?cluster=devnet)

## Guard 9yVPGMcCisKDrw7tUKPiD46SXemjJxkCobA6ypUNGLBZ (runaway agent, current program (keeper set))

- Guard account: [9yVPGMcCisKDrw7tUKPiD46SXemjJxkCobA6ypUNGLBZ](https://explorer.solana.com/address/9yVPGMcCisKDrw7tUKPiD46SXemjJxkCobA6ypUNGLBZ?cluster=devnet); owner W7ntzEnkuoDQJDRdH3sPLqWeav3HLKK9D3aC5n6pdj5
- init_guard + delegate: [451ncJGUgKovsPHA...](https://explorer.solana.com/tx/451ncJGUgKovsPHA2ow7QjeEvooCUCjnfQ7ypH1s2wCsJN7mkJM9wpYu4zG94wUdNnFFF2cTyFpxCS9zhxjACLzm?cluster=devnet)
- accepted order: [5BMxyxvvmbe4REfD...](https://explorer.solana.com/tx/5BMxyxvvmbe4REfDUspjPADSiJEkAZXh9Nh7RCCHFFehxCBqPqn6PaV6TaNaANz9KFqKxmkpiRupL5NtdaanZQr5?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [2fAqvy9Kv1hsLZCt...](https://explorer.solana.com/tx/2fAqvy9Kv1hsLZCthG1GK5iPNqCjetBC8outfkqHokFtZgkprkyJ6dWfaxG8NTqu8m9NM26CBTYMJ1fxGY9WX2mh?cluster=devnet)
- cancel of a guard-placed order: [57nf8kJhHTjoZujx...](https://explorer.solana.com/tx/57nf8kJhHTjoZujxo62h5Sohmy292RHfCiraj2UH5UsJFLiVVqUZ1ZaYkorm2VfWzCLyERzDBB3KqoXfK1wsMU6T?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [4864hTxBV1Hjf8iU...](https://explorer.solana.com/tx/4864hTxBV1Hjf8iUAHbFV7GGP47pd2W7jMeaUKW7TUPzgmt3REL74u98WLqxtxeWzrZYggi5bQ43WavvqoDybvty?cluster=devnet)
- refused by G3 daily notional (DailyNotionalExceeded): [4CmcwNKFfnjoYQuM...](https://explorer.solana.com/tx/4CmcwNKFfnjoYQuMwoKnpeBCTyuEaGEhd1wuFmoqPLTkew6pgb2Yp74HahevhfH8NKiJ7m7dg21FvkT9yDZvajW?cluster=devnet)
- refused by G6 price band (PriceOutsideBand): [5SLXwUQqwUt32EKV...](https://explorer.solana.com/tx/5SLXwUQqwUt32EKVTA7uaJ9yaPToWVRrPo74kJkz4xisQH3qj2eN7M42Lsa7642soTz7fszEC2vEAtiPtqmZj8RE?cluster=devnet)

## Guard 9AxE8fGTu6Uk4MfEcrnPbnLcH9WnaDaUpmr8VbLnP6PF (language-model agent, before audit round 3 (old layout); history (old layout, not migrated))

- Guard account: [9AxE8fGTu6Uk4MfEcrnPbnLcH9WnaDaUpmr8VbLnP6PF](https://explorer.solana.com/address/9AxE8fGTu6Uk4MfEcrnPbnLcH9WnaDaUpmr8VbLnP6PF?cluster=devnet); owner 4sHrhSUMGjaGk4NJzfTmZd8nGd2mC4cHyCRj5zU5t3fK
- init_guard + delegate: [y4zFFoexJmh5tHFv...](https://explorer.solana.com/tx/y4zFFoexJmh5tHFvnGyfLAxzn2qauSxtjDvvgxv4oTdb38tQVN3CvQC2BSveStm2TiUpJMbiffsisMGiiqGpVPU?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [3YapmBXorXDZbPUE...](https://explorer.solana.com/tx/3YapmBXorXDZbPUE2S44J5NejCyD5x73UY5p6TJF9i5gSwxzsLVUxZXNGjG5zGLHLbtP14D7Yx9MHZNpqPU5EfPH?cluster=devnet)
- accepted order: [2aHT6uDu4ShNzscU...](https://explorer.solana.com/tx/2aHT6uDu4ShNzscUWyAMLHJhXmaooCAtmXTuim9UK3vmgMHZqjnJ5MUNaWB14Qgf3oSwSvG1bNrnJ4EDC9GWWdk5?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [23s8AV3SoRpxkAWk...](https://explorer.solana.com/tx/23s8AV3SoRpxkAWkkM7UcBmtk9m8zNX6DDuWRngJz51E2syFway7nvf7TH18yt7LNPpuh9QsEZ4EFXsZ2rq2VWHk?cluster=devnet)

## Guard AqMLdTG8HDZTZWwMQAmN8kciCGFF16nrDWpSFSh9QA26 (runaway agent, before audit round 3 (old layout); history (old layout, not migrated))

- Guard account: [AqMLdTG8HDZTZWwMQAmN8kciCGFF16nrDWpSFSh9QA26](https://explorer.solana.com/address/AqMLdTG8HDZTZWwMQAmN8kciCGFF16nrDWpSFSh9QA26?cluster=devnet); owner Av8MohP7SfjgYeifJyfmuuJC3dyZTJqoPBACagmgxDPU
- init_guard + delegate: [diiRU1dhVH5LyPzi...](https://explorer.solana.com/tx/diiRU1dhVH5LyPziL5CCyjuov5rkKVJEsWbppJgQS6SeMumaisHyw769sLG3Ey1CF9d7pXnTNufzk9hu15YEnn9?cluster=devnet)
- accepted order: [4N3z5723Bijg35E7...](https://explorer.solana.com/tx/4N3z5723Bijg35E78j9ThKxbxSH5ypkxzk7gVTAS9AfPjNuynUCiLLUmPmzf9MJsstYsMWvAmJRHwbp6ttwix3CT?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [4gtXuWrzW9vTu2qr...](https://explorer.solana.com/tx/4gtXuWrzW9vTu2qr31TMkey7Q5u2dTnoNB4VD9prU94wAnLKWp91egsVfjWZJ6q97e5jxBaxsAeCRJwoqaQRCKtU?cluster=devnet)
- cancel of a guard-placed order: [5Yu6dEFypcwPwHHW...](https://explorer.solana.com/tx/5Yu6dEFypcwPwHHWPstyT8FPBgjvnhXqaU5Uzs9pWG45Td4z96MAuP2fNFNsH9KDd5uChoP17ZiDCKGkkyAZth6q?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [3a3CEoAWrVHgCp7A...](https://explorer.solana.com/tx/3a3CEoAWrVHgCp7AhSmBPN8jG7n5TRfDVVqesuT3N8Yz1UBRNpL9MwcTveHoXSwVAwd1XrdNiNe9csyPCwqj948c?cluster=devnet)
- refused by G3 daily notional (DailyNotionalExceeded): [4o1G7CFFaS9gS1m7...](https://explorer.solana.com/tx/4o1G7CFFaS9gS1m7RmWYV2MhfiDV29uxYUtuKcfu2H3W4KwTPjCcZRiv2z7PA6rZc8UzmhYLzNAFum2bCbixmBfH?cluster=devnet)
- refused by G6 price band (PriceOutsideBand): [4ZcMrPTrZ6kbmv8H...](https://explorer.solana.com/tx/4ZcMrPTrZ6kbmv8HN3QnCxkCkW3E8gMPQKF1UwiA1DqMcCSnhmbfP46W4T3hzdPzGCkNGNBqjeaxMhX5mE75foQo?cluster=devnet)

## Guard HHpGNsHr1jPn8xAdXBF1k57Q2W37Qwbcj1ApV2DhaHoS (language-model agent, after audit round 2; history (old layout, not migrated))

- Guard account: [HHpGNsHr1jPn8xAdXBF1k57Q2W37Qwbcj1ApV2DhaHoS](https://explorer.solana.com/address/HHpGNsHr1jPn8xAdXBF1k57Q2W37Qwbcj1ApV2DhaHoS?cluster=devnet); owner 6RUGGjBn2ukgJz2AArmSGy2iJyK3NxNYpk2MwsmeK6Qa
- init_guard + delegate: [35So5guzQoQXt1tu...](https://explorer.solana.com/tx/35So5guzQoQXt1tuttakZiQ1QKDhATsBUEmyPXU4vXYj3wuSQF3qiWQSoxjaNCLTcSPTvoT2upYfzMfmKLUSBrdx?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [2aAo16cBhBBTZo2i...](https://explorer.solana.com/tx/2aAo16cBhBBTZo2iZC99Dvft1iHgsmoWNVCeQrUd6mqCbFSE1bBCyZuz1bJoLUBi53oHrbiAhzS272sJX5gwYcGV?cluster=devnet)
- accepted order: [2wssxLyA9vMgSpk7...](https://explorer.solana.com/tx/2wssxLyA9vMgSpk7bBvMWG9Kegixo5ZUc5F1YDMExVLmrLRmTAbTN8GmZfCukMBjuRrST6NRnQsEi49VVvYJRVH7?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [5jUcyfq8grHbYCvq...](https://explorer.solana.com/tx/5jUcyfq8grHbYCvq5vbvMdoqBsfod3Dxts9jthnXD81PgjJKn2xwh2JMiuCBwwJAJgn9igBUWfWH7rq67USvw9Sc?cluster=devnet)

## Guard J5G6LggMrmj1XQoJkjb7n4SsRBWjdcxF9Zo92V7ozLRb (runaway agent, after audit round 2; history (old layout, not migrated))

- Guard account: [J5G6LggMrmj1XQoJkjb7n4SsRBWjdcxF9Zo92V7ozLRb](https://explorer.solana.com/address/J5G6LggMrmj1XQoJkjb7n4SsRBWjdcxF9Zo92V7ozLRb?cluster=devnet); owner 7QPUUqz8EBHhoWoUbifXBVdehyauaWsLDCH2ZzxKhoEU
- init_guard + delegate: [3BsrSpmeQF86qDMC...](https://explorer.solana.com/tx/3BsrSpmeQF86qDMCoMKuynH57PkUKCgYEPYjv2XbdnBLLyHsX4dj6Qe6Ti61NZ9L4fBhDQG1FdmhUKtjHvz1WzGr?cluster=devnet)
- accepted order: [XvdjZLGgvMJkyXDJ...](https://explorer.solana.com/tx/XvdjZLGgvMJkyXDJZVozDcxo3RvZ7uK3obQyeyq1fcEr8YTvZjAHw2jRsAvfKjq44NsY4nJCf7Xn1y2iBhKRZfL?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [3j3LapDchu6Ek27u...](https://explorer.solana.com/tx/3j3LapDchu6Ek27uw5WvWBA5RoU8S4pbWoTTN2ZaVwAVrL15Uqkv1x1i28S2yuC8oSCGz11omwX14RVWGxJ4Cofm?cluster=devnet)
- cancel of a guard-placed order: [mLQcoM1QfnmBGQXz...](https://explorer.solana.com/tx/mLQcoM1QfnmBGQXzmvpQEdUcwP9pCv7MSn9JVpvuM5W9NxZfUKxBZrhS8uiaQLn3vrBktDUenaW6PjnAW2v6p5G?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [4bJVdAXpc5ZMVePP...](https://explorer.solana.com/tx/4bJVdAXpc5ZMVePPJ4qXJr9Guc3doHoDceHnNHYu9KpfpGYLt9q6qdKvevicEstsmxRpvFhF1WKyqntJKkPi58Uw?cluster=devnet)
- refused by G3 daily notional (DailyNotionalExceeded): [3Pd8hKa7hLf2L635...](https://explorer.solana.com/tx/3Pd8hKa7hLf2L635pk9U6gngstnSY9DUCiLN3cy2o5rpWqCiy6us1kP7UFmMA9ZX66FU6uDvM9HTy7QmQzSYP8QP?cluster=devnet)
- refused by G6 price band (PriceOutsideBand): [2sw8PxEAL9Vk2pkf...](https://explorer.solana.com/tx/2sw8PxEAL9Vk2pkfbiUbp4njpPF7GbA58issn6Kt32eMFQBZMM9frrbkscEjCvDiJEfSSwxJm73BwtXPio9wY1Hj?cluster=devnet)

## Guard 4VWusXJ79GZtK6M9qBCUbGG9NxwMtTNtGLAgcfag36v6 (language-model agent, after the G10 upgrade; history (old layout, not migrated))

- Guard account: [4VWusXJ79GZtK6M9qBCUbGG9NxwMtTNtGLAgcfag36v6](https://explorer.solana.com/address/4VWusXJ79GZtK6M9qBCUbGG9NxwMtTNtGLAgcfag36v6?cluster=devnet); owner DSQHLMYr6diFQ14jDfmK5FADZb8bh3raHyvy1CAcPGRC
- init_guard + delegate: [5WeMKXQmbhFHHC9z...](https://explorer.solana.com/tx/5WeMKXQmbhFHHC9zS6Y8gJqkPrnn9SxxExNQcEZWLMmRfEzLnmJ1Me3S2E9BWQmRjHdW4nTEB3vHyUYejXoSSjwj?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [bjMAmgdfXuzb8Fnr...](https://explorer.solana.com/tx/bjMAmgdfXuzb8Fnr51qRkVLshiNSax5RG4JJM1amqkwiN4fb6NSB4r3WMnzP8mu9UYoaSoEz9Q2LC7KeQ6pDQxe?cluster=devnet)
- accepted order: [4ffUA5jfmcXwCvDA...](https://explorer.solana.com/tx/4ffUA5jfmcXwCvDAZALHYydg9LFYrXc4qPHZ1at3bYwgqwYaux6dEvu1n2mE3hyUGL9i6tzM8Mzrwt4813AjTWYP?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [3dX8o9rK6KDftjj6...](https://explorer.solana.com/tx/3dX8o9rK6KDftjj6PCDQnRfgMRTTZQ8dsyNBhPgiymqTN22CseGuwhKn8ps2MMdRxK2PLBzteA2mmmQTThnEA9aT?cluster=devnet)

## Guard HMnCj9kmouZS14WnLjn57wua6i1U4WZoVpWooFNyRXcM (runaway agent, after the G10 upgrade; history (old layout, not migrated))

- Guard account: [HMnCj9kmouZS14WnLjn57wua6i1U4WZoVpWooFNyRXcM](https://explorer.solana.com/address/HMnCj9kmouZS14WnLjn57wua6i1U4WZoVpWooFNyRXcM?cluster=devnet); owner 82mnXnUarcheQHgknMG3uYGwxJ7ghQN1L7VrS8BqdRhX
- init_guard + delegate: [268B2cxLEeABm4mt...](https://explorer.solana.com/tx/268B2cxLEeABm4mtPWiLEQDtCNrxmX9nhpSDcAsCtqpo44KMpAHBwecvsSRnj2gzqA1zmEpd3FMTgiP7QK73j3QQ?cluster=devnet)
- accepted order: [37YBMqW8ayFMhFV3...](https://explorer.solana.com/tx/37YBMqW8ayFMhFV3jVaAWbrqZm1A8PdDzCgfhVWBuRNbk1RRi9vgzAuqe8jcKayGjjj2LJosk2JGiZyY4McZgCzQ?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [42ZQh37eHgdCi6M5...](https://explorer.solana.com/tx/42ZQh37eHgdCi6M5xUaB6YkWK7C8Y63orVrxhGAkB4WxDLBKMmsZBgk4eVcYah9zAmoGtztQow1zvn5Z8Sh5aiYM?cluster=devnet)
- cancel of a guard-placed order: [rQV6ydh34Hvwd596...](https://explorer.solana.com/tx/rQV6ydh34Hvwd596q4upyzJy5CxX98JWbDhHUc43YbVLap7dyhqNuTuZsH5W7oBV4c6ndvrZrpa2eijbJzd2C1y?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [2MgCgmoWzbRBgAh5...](https://explorer.solana.com/tx/2MgCgmoWzbRBgAh5na1iSDYU2x9KYvpBKrT2JbUTtaprjuS79ngejzNjmDyccTp2k2wsbzTDMZZFutBnmuvBMHqD?cluster=devnet)
- refused by G3 daily notional (DailyNotionalExceeded): [RQCAg1hHZTu8AMCe...](https://explorer.solana.com/tx/RQCAg1hHZTu8AMCeSkULHN69GH5bEQnTWsjrXcuAVZMnX6iuTf18kxDaBnRSbxg8qu4gdpvbBnYe1F5WHxhV6ME?cluster=devnet)
- refused by G6 price band (PriceOutsideBand): [7HrRUd7NEKxz8nWy...](https://explorer.solana.com/tx/7HrRUd7NEKxz8nWyC8dzELHdYKXRg4QjtYayvXJhjU9rhLDMNciYCRt3cXRvBVVVLt8fq7KRgtoDh3h6deAN9Lf?cluster=devnet)

## Guard GVyy5VbPerEqCSNKk2UZ3afzb7MV2y5VAdL8baZnFCSQ (runaway agent, after the R5 upgrade, before G10; history (old layout, not migrated))

- Guard account: [GVyy5VbPerEqCSNKk2UZ3afzb7MV2y5VAdL8baZnFCSQ](https://explorer.solana.com/address/GVyy5VbPerEqCSNKk2UZ3afzb7MV2y5VAdL8baZnFCSQ?cluster=devnet); owner 2WV7NA3o48WUpU6Rh7XWLr969789xyXJkBY99VjjBMJ8
- init_guard + delegate: [23cHUeudJYShSfET...](https://explorer.solana.com/tx/23cHUeudJYShSfETodzjunHQ28mSnncd22gwVvyrB9TRUwLuNbbSoasYQWeZkuddMJZnJj6wKpTZtPHHGHBHiV53?cluster=devnet)
- accepted order: [4Y7PA4LuooVFhAQu...](https://explorer.solana.com/tx/4Y7PA4LuooVFhAQuJnwuMtSnGqgNbhmi9LzK27a25FYF6UqAoQoqGomsuiUJAqCZsNZSjWesWRQPmSYyiKcYcWfC?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [2emMMPkHHFEaD6A4...](https://explorer.solana.com/tx/2emMMPkHHFEaD6A4Pxj3oT9jFJLMKpNrYUaL9wH2JvQP5RYdEqV2mQeDKqFA2TJmEp2BGbhy4qiCjEyJJQmr1EZg?cluster=devnet)
- cancel of a guard-placed order: [3uLwzvA2JFjgj6bu...](https://explorer.solana.com/tx/3uLwzvA2JFjgj6bund3pshhEGsfM93DjoSdwKz5NG3SnwnttePipW5ehyoBUNgB3Jom8QvWyMskMcVyCYzgbZxqe?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [4RY5PQ7QX2zwEpzZ...](https://explorer.solana.com/tx/4RY5PQ7QX2zwEpzZLPvsG5Ut35NMx1yLNHbfujgQjQbgxcxMR6wQCfQ4AzBPgKNw2miYgJEj2VErejzfX3rqtKnv?cluster=devnet)
- refused by G3 daily notional (DailyNotionalExceeded): [4rZv7jfkDPTWKRtL...](https://explorer.solana.com/tx/4rZv7jfkDPTWKRtLfeKvADWYRKrL1S3kyyEasXnGfsqmV2UBqyPaEZLu2C2MWZwD9Sv4Qt1q8zm1XtgReZupwstH?cluster=devnet)
- refused by G6 price band (PriceOutsideBand): [4LKc4Zq5QM4zo6zB...](https://explorer.solana.com/tx/4LKc4Zq5QM4zo6zBFJLUE1eWsrKYnDzZ8tiSaFkMbBXutxTrPPciXUAZevA9Xkzi95DR4MbGvNV41SsijLYFFnit?cluster=devnet)

## Guard 6b87jkEU46X3crEzURwdGmoMPnmYR4sy4HgAGSUSTv8h (language-model agent, before the R5 upgrade; history (old layout, not migrated))

- Guard account: [6b87jkEU46X3crEzURwdGmoMPnmYR4sy4HgAGSUSTv8h](https://explorer.solana.com/address/6b87jkEU46X3crEzURwdGmoMPnmYR4sy4HgAGSUSTv8h?cluster=devnet); owner Na2srj12TcQ778fVuEB1pSQpyR94mPzQmbLXAHidhPU
- init_guard + delegate: [2WfBbemJpvbaDtXW...](https://explorer.solana.com/tx/2WfBbemJpvbaDtXWH13tZ8eZik8NqhRvod1gHGh3jUFETiyT78BQnaPLsC8af2ZyECV6xqHZjJX8KQndgWLF7rWg?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [5yCeCLrJn1KX5itW...](https://explorer.solana.com/tx/5yCeCLrJn1KX5itWy7NyBf1Jb3L47H3QDaF23aXmfvVbyZrW4VvLhszsdHub1PF4MUxoDLk4VdRKb9PwpJGTyvzh?cluster=devnet)
- accepted order: [sJ6LBtpVa9bW9SR5...](https://explorer.solana.com/tx/sJ6LBtpVa9bW9SR5MfAiRVJCriF6XevY9zJu7nKFsdLv8XJJmEwGD8QJkFo345FCXbbmhpkCJWdXVYp5AALzwLj?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [5m1RHS7Jduc8VNYc...](https://explorer.solana.com/tx/5m1RHS7Jduc8VNYc3RWFPj1iuQrHBi9HCDZt9db4rhnjK7U7wD22aTrtwt158aj2YdkQodEgWGc3mytfBCQQ9iBx?cluster=devnet)

## Guard 3JSerd6KBZrW85CHMATFHqKdGAqLYKscWaX29oYf4Yeb (runaway agent; history (old layout, not migrated))

- Guard account: [3JSerd6KBZrW85CHMATFHqKdGAqLYKscWaX29oYf4Yeb](https://explorer.solana.com/address/3JSerd6KBZrW85CHMATFHqKdGAqLYKscWaX29oYf4Yeb?cluster=devnet); owner Ac1C1ipfLasLAwHWcNQCFVKbcXvjsSPKvJr7aGUgdgKD
- init_guard + delegate: [5puRFH9Rh59ijQFj...](https://explorer.solana.com/tx/5puRFH9Rh59ijQFjmUoyoJLnR7gLP4USQ5gQiTt7qe5zxwgKEZGsdCDakTVc4v3oTua4jTUJUnRQssdYFL6ib2Er?cluster=devnet)
- accepted order: [hu9CzRXpiiTYbDU1...](https://explorer.solana.com/tx/hu9CzRXpiiTYbDU1FM2YPHTLhaoip7RBMgdWWs7pwktkh4kcXp36cGgUjhxwPvW1Tu15W8NhgBKkE1KxkV1KAvy?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [Uwj3tFQAnywrPrEU...](https://explorer.solana.com/tx/Uwj3tFQAnywrPrEUQYB8jn8tQh4Xy7vz77nNnJPnc8svAQdQRR8m2Ur5jYUBXvV5wX3cCrWq1UWUyZCMqfiJiru?cluster=devnet)
- cancel of a guard-placed order: [2L3dTEEteeSL6Wbm...](https://explorer.solana.com/tx/2L3dTEEteeSL6WbmsGpp1JG8nKytZTwbMRRFESZZ3ZfEsvkXLCjNQEoQ2PZC6aYHuM6Nr4C2q61H86njagCeESqg?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [4UPCntENVZhpofvK...](https://explorer.solana.com/tx/4UPCntENVZhpofvKAcMfuJM6icTxMf185y6np5ahDwzH9HAoPBXvBv4keaqFTXjAGFooAdBxTXjZQnT9ZLedb2Ld?cluster=devnet)
- refused by G3 daily notional (DailyNotionalExceeded): [2EWAPMKMoKSPiAbh...](https://explorer.solana.com/tx/2EWAPMKMoKSPiAbhsnpzBCwYK6YDsVx5WEnoim7Ce5wiVjfnv7ou9P8LuqHY95ChBMZFGfj9jLAGqbrfro2fNB2V?cluster=devnet)
- refused by G6 price band (PriceOutsideBand): [4PCJRof5GnzLe68K...](https://explorer.solana.com/tx/4PCJRof5GnzLe68Kot4DArhnBBq8R1zCFdYQ23CKCnDKEq7fLtXcrYLHEUGXFq5Yr8KACDSYo7HkQ8HjsRhGLQXW?cluster=devnet)

## Guard 8gnjzC3g7FHDBV7pAjjT7u3XgDk3MVncAw2eVdsneMfy (calm agent; history (old layout, not migrated))

- Guard account: [8gnjzC3g7FHDBV7pAjjT7u3XgDk3MVncAw2eVdsneMfy](https://explorer.solana.com/address/8gnjzC3g7FHDBV7pAjjT7u3XgDk3MVncAw2eVdsneMfy?cluster=devnet); owner DHEMmLniLTKaLsVmbr4juWEuzuUiMq7gspRKrKBgAdVD
- init_guard + delegate: [5dUxZHHEVbTRZEs2...](https://explorer.solana.com/tx/5dUxZHHEVbTRZEs26fmsta3PawVRV4GyU2WYkQtrHdHx7GqLsvBBXess3HmpDof7URioYww1mFgW9EhyiKoGExC?cluster=devnet)
- accepted order: [kQvqm57bY3WTWr2g...](https://explorer.solana.com/tx/kQvqm57bY3WTWr2ghrny4Zu9SEdMpkx32SENjQyou69XVDUNyFPDjVkjUnaRdMXtCUgzwTFoE1R4Sxy8m93pFA7?cluster=devnet)
