# Devnet receipts

Guardrail's guard program on Solana devnet, with the fixed code (after audit findings F1 to F4).
Velocity's devnet oracle is weeks old, so orders rest on Velocity devnet and do not fill; the demo guards use a loose
staleness limit for that reason. Fills at moving prices are shown on a local surfpool fork (see the README).

- Program: [BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy](https://explorer.solana.com/address/BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy?cluster=devnet) (sha256 of the deployed bytes in notes/devnet-guard-so.sha256)
- Deploy: [4c2TQWreEgks7ocw...](https://explorer.solana.com/tx/4c2TQWreEgks7ocw9fr8Hkd2dggPtvoLeAJupWBYTw5yHszuR96ENoPdGXvR7CzpqcexxjCrVxJ3Www2n2CxnTZC?cluster=devnet)

## Guard 3JSerd6KBZrW85CHMATFHqKdGAqLYKscWaX29oYf4Yeb (runaway agent)

- Guard account: [3JSerd6KBZrW85CHMATFHqKdGAqLYKscWaX29oYf4Yeb](https://explorer.solana.com/address/3JSerd6KBZrW85CHMATFHqKdGAqLYKscWaX29oYf4Yeb?cluster=devnet); owner Ac1C1ipfLasLAwHWcNQCFVKbcXvjsSPKvJr7aGUgdgKD
- init_guard + delegate: [5puRFH9Rh59ijQFj...](https://explorer.solana.com/tx/5puRFH9Rh59ijQFjmUoyoJLnR7gLP4USQ5gQiTt7qe5zxwgKEZGsdCDakTVc4v3oTua4jTUJUnRQssdYFL6ib2Er?cluster=devnet)
- accepted order: [hu9CzRXpiiTYbDU1...](https://explorer.solana.com/tx/hu9CzRXpiiTYbDU1FM2YPHTLhaoip7RBMgdWWs7pwktkh4kcXp36cGgUjhxwPvW1Tu15W8NhgBKkE1KxkV1KAvy?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [Uwj3tFQAnywrPrEU...](https://explorer.solana.com/tx/Uwj3tFQAnywrPrEUQYB8jn8tQh4Xy7vz77nNnJPnc8svAQdQRR8m2Ur5jYUBXvV5wX3cCrWq1UWUyZCMqfiJiru?cluster=devnet)
- cancel of a guard-placed order: [2L3dTEEteeSL6Wbm...](https://explorer.solana.com/tx/2L3dTEEteeSL6WbmsGpp1JG8nKytZTwbMRRFESZZ3ZfEsvkXLCjNQEoQ2PZC6aYHuM6Nr4C2q61H86njagCeESqg?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [4UPCntENVZhpofvK...](https://explorer.solana.com/tx/4UPCntENVZhpofvKAcMfuJM6icTxMf185y6np5ahDwzH9HAoPBXvBv4keaqFTXjAGFooAdBxTXjZQnT9ZLedb2Ld?cluster=devnet)
- refused by G3 daily notional (DailyNotionalExceeded): [2EWAPMKMoKSPiAbh...](https://explorer.solana.com/tx/2EWAPMKMoKSPiAbhsnpzBCwYK6YDsVx5WEnoim7Ce5wiVjfnv7ou9P8LuqHY95ChBMZFGfj9jLAGqbrfro2fNB2V?cluster=devnet)
- refused by G6 price band (PriceOutsideBand): [4PCJRof5GnzLe68K...](https://explorer.solana.com/tx/4PCJRof5GnzLe68Kot4DArhnBBq8R1zCFdYQ23CKCnDKEq7fLtXcrYLHEUGXFq5Yr8KACDSYo7HkQ8HjsRhGLQXW?cluster=devnet)

## Guard 8gnjzC3g7FHDBV7pAjjT7u3XgDk3MVncAw2eVdsneMfy (calm agent)

- Guard account: [8gnjzC3g7FHDBV7pAjjT7u3XgDk3MVncAw2eVdsneMfy](https://explorer.solana.com/address/8gnjzC3g7FHDBV7pAjjT7u3XgDk3MVncAw2eVdsneMfy?cluster=devnet); owner DHEMmLniLTKaLsVmbr4juWEuzuUiMq7gspRKrKBgAdVD
- init_guard + delegate: [5dUxZHHEVbTRZEs2...](https://explorer.solana.com/tx/5dUxZHHEVbTRZEs26fmsta3PawVRV4GyU2WYkQtrHdHx7GqLsvBBXess3HmpDof7URioYww1mFgW9EhyiKoGExC?cluster=devnet)
- accepted order: [kQvqm57bY3WTWr2g...](https://explorer.solana.com/tx/kQvqm57bY3WTWr2ghrny4Zu9SEdMpkx32SENjQyou69XVDUNyFPDjVkjUnaRdMXtCUgzwTFoE1R4Sxy8m93pFA7?cluster=devnet)
