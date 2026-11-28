# How the exit bot and the Telegram bot are deployed

The function `stusds-exit` on Supabase is a three-line file that imports this repository's
`supabase/functions/stusds-exit/index.ts` from GitHub at one pinned commit:

```ts
import 'https://raw.githubusercontent.com/evhg/cryptoalerts/<commit>/supabase/functions/stusds-exit/index.ts'
```

Why: the bot's sources are about 250 KB. Sending them through the deploy tool by hand is slow and one wrong
character breaks the bot. A pinned commit is exact, and going back is a one-line change.

To release:
1. Commit and push the change. Take the full commit hash.
2. Deploy the same three lines as `stusds-exit-canary` with that hash and call it with `{"action":"status"}`
   (header `x-cron-secret`). Its answer must match the live function's.
3. Deploy the three lines as `stusds-exit`. Then check `stusds_alert.heartbeats` (kinds `mempool` and `standing`)
   and `stusds_alert.safe_poll_state` a minute or two later.
4. Put a stub back on `stusds-exit-canary`.

The repository must stay publicly readable for a deploy to work. A running version does not fetch anything:
the code is bundled when it is deployed.

The Telegram bot `tg-bot` is deployed the same way from `supabase/functions/tg-bot/index.ts`; check it afterwards
with its `{"action":"status"}`.

History: first used on 28 November 2026 (version 35). The code before that day's change is commit
`97c98349ec6c2b93b4b99ec65c7453a37e7d887c`.
