# Devnet receipts

Guardrail's guard program on Solana devnet, with the fixed code (audit findings F1 to F4, then the R5 review: order lifetime and placed order ids).
Velocity's devnet oracle is weeks old, so orders rest on Velocity devnet and do not fill; the demo guards use a loose
staleness limit for that reason. Fills at moving prices are shown on a local surfpool fork (see the README).

- Program: [BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy](https://explorer.solana.com/address/BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy?cluster=devnet) (sha256 of the deployed bytes in notes/devnet-guard-so.sha256)
- Deploy: [664VGAmNMAg67SuM...](https://explorer.solana.com/tx/664VGAmNMAg67SuM7KT4rJEGZphonZCCVNSuYYaSP9wK6SXKgpSk4iwZ2kpTpK8ReRYNwzgekpGPXLb7jwm8rFgi?cluster=devnet) (G10 upgrade in place, Nov 21; same program id)
- Earlier upgrade (R5 fixes): [61kwLX5YuAKCh949...](https://explorer.solana.com/tx/61kwLX5YuAKCh9498rNqJM1PzB5D8vaS25rdyGsZGUsC3ePEH4QrhwBMCYsjLu73oe3qrMYWZaQkrJLvuN9zumq8?cluster=devnet)
- First deploy with the audit fixes: [4c2TQWreEgks7ocw...](https://explorer.solana.com/tx/4c2TQWreEgks7ocw9fr8Hkd2dggPtvoLeAJupWBYTw5yHszuR96ENoPdGXvR7CzpqcexxjCrVxJ3Www2n2CxnTZC?cluster=devnet)

## Guard HMnCj9kmouZS14WnLjn57wua6i1U4WZoVpWooFNyRXcM (runaway agent, G10 set to 50 dUSDT a day)

- Guard account: [HMnCj9kmouZS14WnLjn57wua6i1U4WZoVpWooFNyRXcM](https://explorer.solana.com/address/HMnCj9kmouZS14WnLjn57wua6i1U4WZoVpWooFNyRXcM?cluster=devnet); owner 82mnXnUarcheQHgknMG3uYGwxJ7ghQN1L7VrS8BqdRhX
- init_guard + delegate: [268B2cxLEeABm4mt...](https://explorer.solana.com/tx/268B2cxLEeABm4mtPWiLEQDtCNrxmX9nhpSDcAsCtqpo44KMpAHBwecvsSRnj2gzqA1zmEpd3FMTgiP7QK73j3QQ?cluster=devnet)
- accepted order: [37YBMqW8ayFMhFV3...](https://explorer.solana.com/tx/37YBMqW8ayFMhFV3jVaAWbrqZm1A8PdDzCgfhVWBuRNbk1RRi9vgzAuqe8jcKayGjjj2LJosk2JGiZyY4McZgCzQ?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [42ZQh37eHgdCi6M5...](https://explorer.solana.com/tx/42ZQh37eHgdCi6M5xUaB6YkWK7C8Y63orVrxhGAkB4WxDLBKMmsZBgk4eVcYah9zAmoGtztQow1zvn5Z8Sh5aiYM?cluster=devnet)
- cancel of a guard-placed order: [rQV6ydh34Hvwd596...](https://explorer.solana.com/tx/rQV6ydh34Hvwd596q4upyzJy5CxX98JWbDhHUc43YbVLap7dyhqNuTuZsH5W7oBV4c6ndvrZrpa2eijbJzd2C1y?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [2MgCgmoWzbRBgAh5...](https://explorer.solana.com/tx/2MgCgmoWzbRBgAh5na1iSDYU2x9KYvpBKrT2JbUTtaprjuS79ngejzNjmDyccTp2k2wsbzTDMZZFutBnmuvBMHqD?cluster=devnet)
- refused by G3 daily notional (DailyNotionalExceeded): [RQCAg1hHZTu8AMCe...](https://explorer.solana.com/tx/RQCAg1hHZTu8AMCeSkULHN69GH5bEQnTWsjrXcuAVZMnX6iuTf18kxDaBnRSbxg8qu4gdpvbBnYe1F5WHxhV6ME?cluster=devnet)
- refused by G6 price band (PriceOutsideBand): [7HrRUd7NEKxz8nWy...](https://explorer.solana.com/tx/7HrRUd7NEKxz8nWyC8dzELHdYKXRg4QjtYayvXJhjU9rhLDMNciYCRt3cXRvBVVVLt8fq7KRgtoDh3h6deAN9Lf?cluster=devnet)

## Guard GVyy5VbPerEqCSNKk2UZ3afzb7MV2y5VAdL8baZnFCSQ (runaway agent, after the R5 upgrade, before G10)

- Guard account: [GVyy5VbPerEqCSNKk2UZ3afzb7MV2y5VAdL8baZnFCSQ](https://explorer.solana.com/address/GVyy5VbPerEqCSNKk2UZ3afzb7MV2y5VAdL8baZnFCSQ?cluster=devnet); owner 2WV7NA3o48WUpU6Rh7XWLr969789xyXJkBY99VjjBMJ8
- init_guard + delegate: [23cHUeudJYShSfET...](https://explorer.solana.com/tx/23cHUeudJYShSfETodzjunHQ28mSnncd22gwVvyrB9TRUwLuNbbSoasYQWeZkuddMJZnJj6wKpTZtPHHGHBHiV53?cluster=devnet)
- accepted order: [4Y7PA4LuooVFhAQu...](https://explorer.solana.com/tx/4Y7PA4LuooVFhAQuJnwuMtSnGqgNbhmi9LzK27a25FYF6UqAoQoqGomsuiUJAqCZsNZSjWesWRQPmSYyiKcYcWfC?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [2emMMPkHHFEaD6A4...](https://explorer.solana.com/tx/2emMMPkHHFEaD6A4Pxj3oT9jFJLMKpNrYUaL9wH2JvQP5RYdEqV2mQeDKqFA2TJmEp2BGbhy4qiCjEyJJQmr1EZg?cluster=devnet)
- cancel of a guard-placed order: [3uLwzvA2JFjgj6bu...](https://explorer.solana.com/tx/3uLwzvA2JFjgj6bund3pshhEGsfM93DjoSdwKz5NG3SnwnttePipW5ehyoBUNgB3Jom8QvWyMskMcVyCYzgbZxqe?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [4RY5PQ7QX2zwEpzZ...](https://explorer.solana.com/tx/4RY5PQ7QX2zwEpzZLPvsG5Ut35NMx1yLNHbfujgQjQbgxcxMR6wQCfQ4AzBPgKNw2miYgJEj2VErejzfX3rqtKnv?cluster=devnet)
- refused by G3 daily notional (DailyNotionalExceeded): [4rZv7jfkDPTWKRtL...](https://explorer.solana.com/tx/4rZv7jfkDPTWKRtLfeKvADWYRKrL1S3kyyEasXnGfsqmV2UBqyPaEZLu2C2MWZwD9Sv4Qt1q8zm1XtgReZupwstH?cluster=devnet)
- refused by G6 price band (PriceOutsideBand): [4LKc4Zq5QM4zo6zB...](https://explorer.solana.com/tx/4LKc4Zq5QM4zo6zBFJLUE1eWsrKYnDzZ8tiSaFkMbBXutxTrPPciXUAZevA9Xkzi95DR4MbGvNV41SsijLYFFnit?cluster=devnet)

## Guard 6b87jkEU46X3crEzURwdGmoMPnmYR4sy4HgAGSUSTv8h (language-model agent, before the R5 upgrade)

- Guard account: [6b87jkEU46X3crEzURwdGmoMPnmYR4sy4HgAGSUSTv8h](https://explorer.solana.com/address/6b87jkEU46X3crEzURwdGmoMPnmYR4sy4HgAGSUSTv8h?cluster=devnet); owner Na2srj12TcQ778fVuEB1pSQpyR94mPzQmbLXAHidhPU
- init_guard + delegate: [2WfBbemJpvbaDtXW...](https://explorer.solana.com/tx/2WfBbemJpvbaDtXWH13tZ8eZik8NqhRvod1gHGh3jUFETiyT78BQnaPLsC8af2ZyECV6xqHZjJX8KQndgWLF7rWg?cluster=devnet)
- refused by G1 order size (OrderTooLarge): [5yCeCLrJn1KX5itW...](https://explorer.solana.com/tx/5yCeCLrJn1KX5itWy7NyBf1Jb3L47H3QDaF23aXmfvVbyZrW4VvLhszsdHub1PF4MUxoDLk4VdRKb9PwpJGTyvzh?cluster=devnet)
- accepted order: [sJ6LBtpVa9bW9SR5...](https://explorer.solana.com/tx/sJ6LBtpVa9bW9SR5MfAiRVJCriF6XevY9zJu7nKFsdLv8XJJmEwGD8QJkFo345FCXbbmhpkCJWdXVYp5AALzwLj?cluster=devnet)
- refused by G4 exposure (ExposureExceeded): [5m1RHS7Jduc8VNYc...](https://explorer.solana.com/tx/5m1RHS7Jduc8VNYc3RWFPj1iuQrHBi9HCDZt9db4rhnjK7U7wD22aTrtwt158aj2YdkQodEgWGc3mytfBCQQ9iBx?cluster=devnet)

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
