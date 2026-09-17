-- Separate keep-alive heartbeat from Finance ingest timestamps, and record
-- how far SP-API finance data has actually been walked forward.
alter table public.account_amazon_credentials
  add column if not exists last_keepalive_at timestamptz,
  add column if not exists last_keepalive_error text,
  add column if not exists finance_synced_through date;

-- The previous last_synced_at value was written by weekly keep-alive / smoke
-- tests, so it looked like ingest was current. Copy it to last_keepalive_at,
-- then reset last_synced_at / finance_synced_through from real sp_api txs.
update public.account_amazon_credentials c
set last_keepalive_at = coalesce(c.last_keepalive_at, c.last_synced_at)
where c.provider = 'sp-api'
  and c.last_synced_at is not null;

update public.account_amazon_credentials c
set
  last_synced_at = src.last_ingested_at,
  finance_synced_through = src.last_sale_date
from (
  select
    account_id,
    max(created_at) as last_ingested_at,
    max(transaction_date) as last_sale_date
  from public.report_transactions
  where source = 'sp_api'
  group by account_id
) src
where c.account_id = src.account_id
  and c.provider = 'sp-api';
