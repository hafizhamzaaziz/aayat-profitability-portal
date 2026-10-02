# Ops note — Amazon API primary (Sellerboard-style periods)

Connected **Amazon SP-API + Ads** accounts use the API as the primary source. Temu / TikTok upload flows are unchanged.

## How data flows

| Surface | Primary source when SP+Ads is healthy |
|---|---|
| Dashboard | Hourly snapshots (`amazon_dashboard_snapshots`) + order-dated facts |
| Inventory / Daily Sales | `inventory_sales_facts_cache` (order date) |
| Saved Reports | Canonical `reports` with `source = sp_api`; arbitrary ranges use the same facts/metrics as Dashboard |
| Expenses (ad spend) | Ads API into `report_ad_spend` |
| Performance | Weekly **parent ASIN** snapshot on Mondays (hourly cron) |
| COGS | Ops costs stay editable; Amazon SKUs are linked/suggested only |

**Manual Amazon CSV upload** stays on **Reports → Compare Amazon**. It does not replace the live API pipeline.

## Hourly cron

Scheduled from **Supabase pg_cron**, not Vercel (the Vercel Hobby plan only allows daily crons, so `vercel.json` has no `crons`). Jobs live in `cron.job`; the helper `ops.portal_cron_call(path)` reads the bearer token from Vault secret `portal_cron_secret` (must equal `CRON_SECRET` in Vercel) and calls `https://portal.aayat.co<path>` via pg_net. SQL: `supabase/migrations/20261002_portal_pg_cron.sql`.

- `portal_amazon_hourly` → `/api/amazon/hourly` at `:15` UTC
- `portal_ads_collect` → `/api/amazon/ads/collect` at `:35`
- `portal_keepalive` → `/api/amazon/keepalive` Monday 03:00 UTC
- Check runs: `select * from cron.job_run_details order by start_time desc limit 20;` and HTTP results (kept ~6h): `select id, status_code, left(content::text,200) from net._http_response order by id desc;`
- Rotate the secret: update the Vercel env var **and** `select vault.update_secret(id, '<new>') from vault.secrets where name='portal_cron_secret'`, then redeploy.
- Each run: Finance/Orders (order-date stamp) + Ads start, then dashboard snapshots; **Monday** also writes Performance parent-ASIN rows
- Settings shows last sync, finance watermark (`finance_synced_through`), and last error

## Performance gaps (not silent)

SP-API Catalog Items can supply title, parent ASIN, and sometimes BSR. **Review count and star rating are not in SP-API.** Use Keepa (or similar) if those columns must autofill. Until then they stay blank unless Ops enters an override.

## Forecast

**This month (forecast)** = MTD metric × (days in calendar month / current UTC day-of-month). Non-Amazon platforms keep existing monthly reports or show "—" for short windows.

## Restore (pre this work)

See [RESTORE-PRE-AMAZON-API-SELLERBOARD.md](./RESTORE-PRE-AMAZON-API-SELLERBOARD.md): git tag `backup/pre-amazon-api-sellerboard-20260921`, Vercel deployment `dpl_3Ejf3T4rwJmYWhzPS9mUnp1YWgX2`, then the Supabase backup taken at that restore point.

## Pilot check (Rexo)

Compare Seller Central + Ads console vs portal for Today / Yesterday / MTD, then one API-vs-manual upload on Compare Amazon.
