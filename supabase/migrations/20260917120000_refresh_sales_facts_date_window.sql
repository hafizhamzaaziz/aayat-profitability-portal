-- Rebuild path for inventory_sales_facts_cache:
-- 1. Optional p_from/p_to so a just-ingested month can be folded in without
--    rebuilding the whole account (wide SP-API syncs were committing txs then
--    dying before the full refresh, leaving max(sale_date) stuck at the
--    previous rebuild — Rexo 2026-07-31 while Aug/Sep sp_api txs already
--    existed).
-- 2. Overlap SP-API vs manual on the *transaction date* covered by an sp_api
--    report period, not on whether the two report rows' periods overlap.
--    Inclusive on both ends (no exclusive period_end).
-- 3. Dedup order lines per sale_date so a later report cannot collapse a
--    different day's units into one row.
-- 4. 180s statement_timeout so PostgREST/API callers are not killed at 8s.

drop function if exists public.refresh_inventory_sales_facts(uuid);

create or replace function public.refresh_inventory_sales_facts(
  p_account_id uuid,
  p_from date default null,
  p_to date default null
)
returns integer
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '180s'
as $function$
declare
  inserted int;
begin
  delete from public.inventory_sales_facts_cache
  where account_id = p_account_id
    and (p_from is null or sale_date >= p_from)
    and (p_to is null or sale_date <= p_to);

  insert into public.inventory_sales_facts_cache (account_id, platform, sku, sale_date, qty)
  with base as (
    select
      rt.account_id,
      rt.platform,
      rt.sku,
      rt.transaction_date::date as sale_date,
      abs(rt.quantity) as qty,
      coalesce(
        nullif(lower(rt.raw_row->>'order id'), ''),
        nullif(lower(rt.raw_row->>'Order item ID'), ''),
        nullif(lower(rt.raw_row->>'Order ID'), ''),
        rt.id::text
      ) as order_key,
      r.created_at as report_created_at
    from public.report_transactions rt
    join public.reports r on r.id = rt.report_id
    where rt.account_id = p_account_id
      and rt.sku is not null
      and rt.quantity is not null
      and rt.quantity > 0
      and rt.transaction_date is not null
      and (p_from is null or rt.transaction_date >= p_from)
      and (p_to is null or rt.transaction_date <= p_to)
      and (
        (lower(rt.platform) like 'amazon%' and lower(coalesce(rt.raw_row->>'type', '')) = 'order')
        or (lower(rt.platform) like 'temu%' and lower(coalesce(rt.raw_row->>'Transaction type', '')) = 'order payment')
      )
      and (
        lower(r.source) = 'sp_api'
        or not exists (
          select 1 from public.reports s
          where s.account_id = rt.account_id
            and lower(s.source) = 'sp_api'
            and lower(s.platform) = lower(r.platform)
            and rt.transaction_date >= s.period_start
            and rt.transaction_date <= s.period_end
        )
      )
  ),
  per_report as (
    select platform, sku, sale_date, order_key, report_created_at, sum(qty) as qty
    from base
    group by platform, sku, sale_date, order_key, report_created_at
  ),
  deduped as (
    select distinct on (platform, order_key, sku, sale_date)
      platform, sku, sale_date, qty
    from per_report
    order by platform, order_key, sku, sale_date, report_created_at desc
  )
  select p_account_id, platform, sku, sale_date, sum(qty) as qty
  from deduped
  group by platform, sku, sale_date;

  get diagnostics inserted = row_count;
  return inserted;
end;
$function$;

grant execute on function public.refresh_inventory_sales_facts(uuid, date, date)
  to authenticated, service_role;
