# Research scripts

Kept from the November 2026 stUSDS investigation (see `LEARNINGS.md`). They were written for a scratch directory:
most expect `viem` in a `node_modules` next to them, and some have an absolute scratch path at the top. Adjust
before running. None of them holds a secret; the keys in `scenarios.mjs` are fixed dummy values for a local fork.

| File | What it does |
|---|---|
| `waitblocks.mjs N` | Wait N new blocks (use it where a shell `sleep` is not allowed) |
| `who.mjs FROM TO`, `lastq.mjs`, `builders9.mjs`, `shares.mjs` | Which builder made which block; builder shares over recent blocks |
| `took.mjs`, `repay.mjs` | Deposits and withdrawals of stUSDS in a block range; one repayment and who took it |
| `census.mjs`, `analyze.py`, `openings.py` | The flow census: every opening, its taker, the builder and what was paid |
| `holders.mjs`, `whalebal.mjs` | Largest stUSDS holders and how their balances moved |
| `busy.mjs` | How often a set of trading pools changes per block |
| `feedwatch.mjs`, `mevshare.mjs` | What the public pending feeds showed; whether a transaction was offered on MEV-Share |
| `spellcheck.mjs`, `safecheck.mjs` | Sky executive vote against the chief's hat; USDS balance and next transaction number of the two Safes |
| `probelogs.mjs` | Events of the `CondProbe` contract in recent blocks, with the builder |
| `scenarios.mjs` | Fork harness: runs the real bot against anvil with a mock database; scenarios for repayments, standing bundles, the 25M, the always-in-the-block withdrawal |
