# @traderton/db

Drizzle schema, migrations and repositories.

## Migrations: read this before changing the schema

**Running migrations is safe.** `pnpm --filter @traderton/db db:migrate` applies
the files listed in `drizzle/meta/_journal.json`, in order. It does not use the
snapshot files.

**Generating the next migration is not safe yet.** `drizzle-kit generate`
(`pnpm --filter @traderton/db db:generate`) compares your schema with the latest
snapshot in `drizzle/meta/`. That snapshot is `0008_snapshot.json`. Migrations
`0009_preset_assessment_data_only` and `0010_capital_changed_at` were written by
hand and have no snapshots. So `generate` thinks 0009 and 0010 are still
unapplied changes. It stops with a "was this column renamed?" prompt (and fails
outright without a terminal). If you answered the prompts, the new migration
would probably repeat the 0009 and 0010 changes and fail on any database that
already has them.

### What to do

Pick one:

1. **Write your migration by hand.** Add `drizzle/00NN_name.sql` and add its entry
   to `drizzle/meta/_journal.json` with a `when` timestamp later than the
   previous entry. This is how 0009 and 0010 were done.
2. **Restore the missing snapshots first** (preferred if you are making several
   changes). Add snapshots for 0009 and 0010 so the chain is complete, then
   confirm `drizzle-kit generate` reports no schema changes before you edit the
   schema. Do not commit a generated migration until you have checked that its
   SQL contains only your change.

Do not run `generate` and accept its output without reading the SQL.

### Status

Not fixed. Nothing is broken today: deploys and `db:migrate` work. The cost is
that the next schema change needs option 1 or 2 above. When snapshots for 0009
and 0010 are added, delete this section.
