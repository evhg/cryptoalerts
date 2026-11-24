# Working agreements

## Time zone
- Always show times in Bangkok time (Asia/Bangkok, UTC+7). Never show UTC, in chat, emails, push notifications, reports or code that formats times for people.
- Convert any UTC timestamp (logs, database rows, block times, APIs) to Bangkok time before showing it.
- Scheduling: when asked for a time, read it as Bangkok time. Cron fields stored in UTC must be converted (Bangkok = UTC+7), or written with `CRON_TZ=Asia/Bangkok`.
- Storage and APIs may keep UTC internally (timestamptz, ISO strings); only what people read changes.
