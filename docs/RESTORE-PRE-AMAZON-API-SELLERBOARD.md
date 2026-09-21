# Restore point — before Amazon API / Sellerboard Dashboard work

Captured **21 Sep 2026** so production can be returned to the pre-change state without archaeology.

## Git

| Item | Value |
|------|--------|
| Production commit | `34b0ca763de1d4e93cc2125f224b58dcd0f58eb4` |
| Message | `feat(inventory): sync Amazon Daily Sales from SP-API for warehouse reports` |
| Tag | `backup/pre-amazon-api-sellerboard-20260921` |
| Branch | `backup/pre-amazon-api-sellerboard` |

```bash
git fetch origin --tags
git checkout backup/pre-amazon-api-sellerboard-20260921
# or: git checkout backup/pre-amazon-api-sellerboard
```

Redeploy that commit to Vercel (pushing the backup branch to `main` is a last resort — prefer rolling the Vercel deployment below).

## Vercel production at restore time

| Item | Value |
|------|--------|
| Alias | https://portal.aayat.co |
| Deployment ID | `dpl_3Ejf3T4rwJmYWhzPS9mUnp1YWgX2` |
| Deployment URL | https://aayat-profitability-portal-13f59taqr-hafizhamzaazizs-projects.vercel.app |
| Created | 17 Sep 2026 21:40 PKT |
| Project | `prj_uSnnW9F80oiHE8gXSAKCONKDlzXw` |
| Team | `team_CbpMElcPI8b7QPXCC2RwLiRa` |

Rollback in the Vercel dashboard: Project → Deployments → promote `dpl_3Ejf3T4rwJmYWhzPS9mUnp1YWgX2` to Production.

CLI:

```bash
npx vercel rollback dpl_3Ejf3T4rwJmYWhzPS9mUnp1YWgX2 --scope team_CbpMElcPI8b7QPXCC2RwLiRa
```

## Supabase

| Item | Value |
|------|--------|
| Project | `aayat-profitability-portal` |
| Ref | `aizlmypcyqluzyzkywxo` |
| Region | `eu-west-1` |
| Plan | **Free** (no point-in-time recovery) |

Free-plan automatic backups are short-lived. Take a Dashboard backup **before merging Amazon API work**:

1. [Supabase Dashboard](https://supabase.com/dashboard/project/aizlmypcyqluzyzkywxo) → **Settings → Infrastructure** (or Database → Backups).
2. Download / confirm the latest backup, or run `supabase db dump` with the database URL if you have it locally.
3. Restore from that backup in the Dashboard if a migration misbehaves, then redeploy the git tag above.

### Row-count snapshot (21 Sep 2026, used as a sanity check after restore)

| Table | Rows |
|-------|------|
| accounts | 15 |
| account_amazon_credentials | 16 |
| reports | 132 |
| report_transactions | 400,076 |
| report_sku_breakdowns | 6,094 |
| inventory_sales_facts_cache | 43,159 |
| inventory_daily_sales | 13,047 |
| cogs | 1,273 |
| cogs_history | 1,547 |
| sku_mappings | 1,514 |
| performance_metrics | 1,204 |
| expense_ledger | 116 |

## Order of restore

1. Promote Vercel deployment `dpl_3Ejf3T4rwJmYWhzPS9mUnp1YWgX2` (fastest — code only).
2. If data is wrong, restore the Supabase backup taken at this restore point, then confirm table counts are near the snapshot.
3. Checkout git tag `backup/pre-amazon-api-sellerboard-20260921` if you need the matching source tree.
