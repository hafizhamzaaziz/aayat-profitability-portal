-- ---------------------------------------------------------------------------
-- 16) Inventory v2 — supplier purchase orders, FBA shipments, channel-aware
--     sales (FBA vs FBM), stock position and demand summaries.
--
--  Flow the planner models:
--    supplier PO  ──receive──▶  3PL warehouse  ──FBA shipment──▶  Amazon FBA
--                                   │                                 │
--                            FBM / Temu / TikTok sales           FBA sales
--
--  Stock position per SKU = latest stock take (inventory_levels) + movements
--  recorded after that count − sales logged after that count. Everything is
--  additive to the v1 tables so the old data keeps working.
-- ---------------------------------------------------------------------------

-- Channel on Amazon unit facts: 'fba' (Amazon fulfilled) / 'fbm' (seller).
alter table public.inventory_sales_facts_cache
  add column if not exists channel text;
create index if not exists inventory_sales_facts_cache_acct_date_idx
  on public.inventory_sales_facts_cache (account_id, sale_date);

alter table public.inventory_daily_sales
  add column if not exists channel text;
alter table public.inventory_daily_sales
  drop constraint if exists inventory_daily_sales_channel_check;
alter table public.inventory_daily_sales
  add constraint inventory_daily_sales_channel_check
  check (channel is null or channel in ('fba', 'fbm'));

-- Planning settings (lead-time stages, safety, velocity blend).
alter table public.inventory_defaults
  add column if not exists fba_transit_days integer not null default 7,
  add column if not exists fba_checkin_days integer not null default 5,
  add column if not exists safety_days integer not null default 14,
  add column if not exists overstock_days integer not null default 180,
  add column if not exists growth_rate_pct numeric(6,2) not null default 0,
  add column if not exists velocity_weights jsonb not null default '{"d7": 0.2, "d30": 0.5, "d90": 0.3}'::jsonb;

-- Suppliers / manufacturers.
create table if not exists public.inventory_suppliers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  name text not null,
  contact_name text,
  email text,
  phone text,
  country text,
  currency text not null default 'GBP',
  manufacturing_days integer not null default 30,
  shipping_days integer not null default 45,
  payment_terms text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, name)
);

alter table public.sku_mappings
  add column if not exists supplier_id uuid references public.inventory_suppliers(id) on delete set null,
  add column if not exists moq integer,
  add column if not exists default_pack_profile_id uuid references public.pack_profiles(id) on delete set null,
  add column if not exists velocity_override numeric(10,3),
  add column if not exists is_planned boolean not null default true;

-- Purchase orders to suppliers.
create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  po_number text not null,
  supplier_id uuid references public.inventory_suppliers(id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft', 'ordered', 'in_production', 'shipped', 'partially_received', 'received', 'closed', 'cancelled')),
  order_date date,
  expected_ready_date date,
  expected_arrival_date date,
  destination_warehouse_id uuid references public.inventory_warehouses(id) on delete set null,
  currency text not null default 'GBP',
  freight_cost numeric(14,2) not null default 0,
  duty_cost numeric(14,2) not null default 0,
  other_cost numeric(14,2) not null default 0,
  tracking_ref text,
  notes text,
  parent_po_id uuid references public.purchase_orders(id) on delete set null,
  legacy_plan_id uuid,
  cogs_applied_at timestamptz,
  created_by uuid references public.users(id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, po_number)
);
create index if not exists purchase_orders_account_status_idx
  on public.purchase_orders (account_id, status);

create table if not exists public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  sku_mapping_id uuid not null references public.sku_mappings(id) on delete cascade,
  ordered_units integer not null default 0 check (ordered_units >= 0),
  received_units integer not null default 0 check (received_units >= 0),
  unit_cost numeric(14,4) not null default 0,
  pack_profile_id uuid references public.pack_profiles(id) on delete set null,
  units_per_box integer,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists purchase_order_items_po_idx on public.purchase_order_items (purchase_order_id);
create index if not exists purchase_order_items_mapping_idx on public.purchase_order_items (sku_mapping_id);

create table if not exists public.purchase_order_receipts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  purchase_order_item_id uuid not null references public.purchase_order_items(id) on delete cascade,
  received_date date not null default current_date,
  units integer not null check (units > 0),
  warehouse_id uuid references public.inventory_warehouses(id) on delete set null,
  movement_id uuid,
  notes text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists purchase_order_receipts_po_idx on public.purchase_order_receipts (purchase_order_id);

-- Inbound shipments from the warehouse to Amazon FBA (created in Seller
-- Central; tracked here: sent vs received).
create table if not exists public.fba_shipments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  shipment_name text not null,
  amazon_shipment_id text,
  status text not null default 'draft'
    check (status in ('draft', 'shipped', 'receiving', 'closed', 'cancelled')),
  source_warehouse_id uuid references public.inventory_warehouses(id) on delete set null,
  ship_date date,
  expected_arrival_date date,
  carrier text,
  tracking_ref text,
  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  notes text,
  legacy_plan_id uuid,
  created_by uuid references public.users(id) on delete set null,
  shipped_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fba_shipments_account_status_idx on public.fba_shipments (account_id, status);

create table if not exists public.fba_shipment_items (
  id uuid primary key default gen_random_uuid(),
  fba_shipment_id uuid not null references public.fba_shipments(id) on delete cascade,
  sku_mapping_id uuid not null references public.sku_mappings(id) on delete cascade,
  planned_units integer not null default 0 check (planned_units >= 0),
  sent_units integer not null default 0 check (sent_units >= 0),
  received_units integer not null default 0 check (received_units >= 0),
  pack_profile_id uuid references public.pack_profiles(id) on delete set null,
  units_per_box integer,
  boxes integer,
  pallets numeric(12,2),
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists fba_shipment_items_shipment_idx on public.fba_shipment_items (fba_shipment_id);
create index if not exists fba_shipment_items_mapping_idx on public.fba_shipment_items (sku_mapping_id);

-- Movements now say which bucket they touch and what document created them.
alter table public.inventory_movements
  add column if not exists location text not null default 'warehouse',
  add column if not exists warehouse_id uuid references public.inventory_warehouses(id) on delete set null,
  add column if not exists reference_type text,
  add column if not exists reference_id uuid;
alter table public.inventory_movements
  drop constraint if exists inventory_movements_location_check;
alter table public.inventory_movements
  add constraint inventory_movements_location_check check (location in ('warehouse', 'amazon'));
alter table public.inventory_movements
  drop constraint if exists inventory_movements_movement_type_check;
alter table public.inventory_movements
  add constraint inventory_movements_movement_type_check
  check (movement_type in (
    'inbound', 'outbound', 'adjustment', 'amazon_transfer',
    'po_receipt', 'fba_shipment_out', 'fba_received',
    'customer_return', 'b2b_outbound', 'damaged', 'stock_take'
  ));
create index if not exists inventory_movements_account_mapping_created_idx
  on public.inventory_movements (account_id, sku_mapping_id, created_at);

alter table public.inventory_levels
  add column if not exists source text not null default 'manual',
  add column if not exists notes text;

alter table public.inventory_daily_sales
  drop constraint if exists inventory_daily_sales_source_check;

-- Live FBA stock snapshot (FBA Inventory API; needs the Amazon Fulfillment role).
create table if not exists public.amazon_fba_inventory (
  account_id uuid not null references public.accounts(id) on delete cascade,
  sku text not null,
  asin text,
  fnsku text,
  fulfillable integer not null default 0,
  inbound_working integer not null default 0,
  inbound_shipped integer not null default 0,
  inbound_receiving integer not null default 0,
  reserved integer not null default 0,
  unfulfillable integer not null default 0,
  snapshot_at timestamptz not null default now(),
  primary key (account_id, sku)
);

-- RLS: same pattern as the other inventory tables.
alter table public.inventory_suppliers enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.purchase_order_receipts enable row level security;
alter table public.fba_shipments enable row level security;
alter table public.fba_shipment_items enable row level security;
alter table public.amazon_fba_inventory enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'inventory_suppliers', 'purchase_orders', 'purchase_order_items', 'purchase_order_receipts',
    'fba_shipments', 'fba_shipment_items', 'amazon_fba_inventory'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_select_authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_select_authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_modify_admin_team', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.current_user_role() in (''admin'', ''team'')) with check (public.current_user_role() in (''admin'', ''team''))',
      t || '_modify_admin_team', t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- refresh_inventory_sales_facts: same rebuild as before, now stamping the
-- Amazon fulfilment channel from the transaction row ("Amazon" = FBA,
-- "Seller" = FBM).
-- ---------------------------------------------------------------------------
create or replace function public.refresh_inventory_sales_facts(
  p_account_id uuid,
  p_from date default null,
  p_to date default null
)
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = '180s'
as $$
declare
  inserted int;
begin
  delete from public.inventory_sales_facts_cache
  where account_id = p_account_id
    and (p_from is null or sale_date >= p_from)
    and (p_to is null or sale_date <= p_to);

  insert into public.inventory_sales_facts_cache (account_id, platform, sku, sale_date, qty, channel)
  with base as (
    select
      rt.account_id,
      rt.platform,
      rt.sku,
      case
        when lower(rt.platform) like 'amazon%'
          and coalesce(nullif(substring(trim(coalesce(rt.raw_row->>'purchase date', '')) from 1 for 10), ''), '') ~ '^\d{4}-\d{2}-\d{2}$'
        then substring(trim(rt.raw_row->>'purchase date') from 1 for 10)::date
        else rt.transaction_date::date
      end as sale_date,
      abs(rt.quantity) as qty,
      case
        when lower(rt.platform) not like 'amazon%' then null
        when lower(trim(coalesce(rt.raw_row->>'fulfilment', rt.raw_row->>'fulfillment', ''))) in ('amazon', 'afn') then 'fba'
        when lower(trim(coalesce(rt.raw_row->>'fulfilment', rt.raw_row->>'fulfillment', ''))) in ('seller', 'mfn', 'merchant') then 'fbm'
        else null
      end as channel,
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
      and (
        (lower(rt.platform) like 'amazon%' and lower(coalesce(rt.raw_row->>'type', '')) = 'order')
        or (lower(rt.platform) like 'temu%' and lower(coalesce(rt.raw_row->>'Transaction type', '')) = 'order payment')
      )
      and (
        lower(rt.platform) not like 'amazon%'
        or lower(coalesce(r.source, '')) = 'sp_api'
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
  filtered as (
    select *
    from base
    where sale_date is not null
      and (p_from is null or sale_date >= p_from)
      and (p_to is null or sale_date <= p_to)
  ),
  per_report as (
    select platform, sku, sale_date, channel, order_key, report_created_at, sum(qty) as qty
    from filtered
    group by platform, sku, sale_date, channel, order_key, report_created_at
  ),
  deduped as (
    select distinct on (platform, order_key, sku, sale_date)
      platform, sku, sale_date, channel, qty
    from per_report
    order by platform, order_key, sku, sale_date, report_created_at desc
  )
  select p_account_id, platform, sku, sale_date, sum(qty) as qty, channel
  from deduped
  group by platform, sku, sale_date, channel;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

-- ---------------------------------------------------------------------------
-- sync_amazon_daily_sales_from_facts: channel-aware. FBM rows default to the
-- Sportive (or first) warehouse because they are dispatched from the 3PL; FBA
-- rows carry no warehouse (Amazon ships them). Warehouse edits are preserved.
-- ---------------------------------------------------------------------------
create or replace function public.sync_amazon_daily_sales_from_facts(
  p_account_id uuid,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_warehouse_id uuid;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_filled integer := 0;
begin
  if p_account_id is null then
    raise exception 'account id is required';
  end if;

  select w.id
    into v_warehouse_id
  from public.inventory_warehouses w
  where w.account_id = p_account_id
  order by case when lower(trim(w.name)) = 'sportive' then 0 else 1 end, w.name asc
  limit 1;

  -- Legacy rows (pre-channel) were the warehouse dispatch log → treat as FBM.
  update public.inventory_daily_sales
  set channel = 'fbm'
  where account_id = p_account_id
    and platform = 'amazon'
    and channel is null
    and (p_from is null or sale_date >= p_from)
    and (p_to is null or sale_date <= p_to);

  create temporary table if not exists _amazon_daily_facts (
    sku_mapping_id uuid not null,
    sale_date date not null,
    channel text not null,
    sold_units integer not null,
    primary key (sku_mapping_id, sale_date, channel)
  ) on commit drop;
  truncate _amazon_daily_facts;

  insert into _amazon_daily_facts (sku_mapping_id, sale_date, channel, sold_units)
  select
    m.id,
    f.sale_date,
    coalesce(f.channel, 'fbm'),
    greatest(0, round(sum(f.qty))::integer)
  from public.inventory_sales_facts_cache f
  join (
    select distinct on (upper(trim(replace(sm.amazon_sku, chr(160), ' '))))
      sm.id,
      upper(trim(replace(sm.amazon_sku, chr(160), ' '))) as sku_key
    from public.sku_mappings sm
    where sm.account_id = p_account_id
      and sm.amazon_sku is not null
      and trim(sm.amazon_sku) <> ''
    order by upper(trim(replace(sm.amazon_sku, chr(160), ' '))), sm.created_at asc, sm.id asc
  ) m on m.sku_key = upper(trim(replace(coalesce(f.sku, ''), chr(160), ' ')))
  where f.account_id = p_account_id
    and lower(coalesce(f.platform, '')) like 'amazon%'
    and f.qty > 0
    and f.sale_date >= date '2020-01-01'
    and (p_from is null or f.sale_date >= p_from)
    and (p_to is null or f.sale_date <= p_to)
  group by m.id, f.sale_date, coalesce(f.channel, 'fbm')
  having round(sum(f.qty)) > 0;

  insert into public.inventory_daily_sales (
    account_id, sku_mapping_id, sale_date, platform, channel, warehouse_id,
    sold_units, returns_units, collected_units, notes, source
  )
  select
    p_account_id,
    f.sku_mapping_id,
    f.sale_date,
    'amazon',
    f.channel,
    case when f.channel = 'fba' then null else v_warehouse_id end,
    f.sold_units,
    0,
    0,
    null,
    'sp_api'
  from _amazon_daily_facts f
  where not exists (
    select 1
    from public.inventory_daily_sales d
    where d.account_id = p_account_id
      and d.sku_mapping_id = f.sku_mapping_id
      and d.sale_date = f.sale_date
      and d.platform = 'amazon'
      and d.channel = f.channel
  );
  get diagnostics v_inserted = row_count;

  update public.inventory_daily_sales d
  set
    sold_units = f.sold_units,
    warehouse_id = case when f.channel = 'fba' then d.warehouse_id else coalesce(d.warehouse_id, v_warehouse_id) end,
    source = case when d.source = 'manual' then d.source else 'sp_api' end,
    updated_at = now()
  from _amazon_daily_facts f
  join (
    select sku_mapping_id, sale_date, channel
    from public.inventory_daily_sales
    where account_id = p_account_id
      and platform = 'amazon'
      and (p_from is null or sale_date >= p_from)
      and (p_to is null or sale_date <= p_to)
    group by sku_mapping_id, sale_date, channel
    having count(*) = 1
  ) k on k.sku_mapping_id = f.sku_mapping_id and k.sale_date = f.sale_date and k.channel = f.channel
  where d.account_id = p_account_id
    and d.platform = 'amazon'
    and d.channel = f.channel
    and d.sku_mapping_id = f.sku_mapping_id
    and d.sale_date = f.sale_date
    and (
      d.sold_units is distinct from f.sold_units
      or (d.warehouse_id is null and v_warehouse_id is not null and f.channel <> 'fba')
    );
  get diagnostics v_updated = row_count;

  -- FBM legacy rows whose units included FBA sales: the facts now hold the FBM
  -- share only, so the update above already corrected them. Fill warehouses.
  update public.inventory_daily_sales d
  set warehouse_id = v_warehouse_id, updated_at = now()
  where d.account_id = p_account_id
    and d.platform = 'amazon'
    and coalesce(d.channel, 'fbm') <> 'fba'
    and d.warehouse_id is null
    and v_warehouse_id is not null;
  get diagnostics v_filled = row_count;

  return jsonb_build_object(
    'account_id', p_account_id,
    'from', p_from,
    'to', p_to,
    'inserted', v_inserted,
    'updated', v_updated,
    'warehouses_filled', v_filled,
    'default_warehouse_id', v_warehouse_id
  );
end;
$$;

revoke all on function public.sync_amazon_daily_sales_from_facts(uuid, date, date) from public, anon;
grant execute on function public.sync_amazon_daily_sales_from_facts(uuid, date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- inventory_stock_position: one row per SKU mapping with the latest stock take
-- and everything that happened after it.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_stock_position(p_account_id uuid)
returns table (
  sku_mapping_id uuid,
  baseline_date date,
  baseline_at timestamptz,
  baseline_source text,
  baseline_amazon integer,
  baseline_warehouse integer,
  moves_warehouse integer,
  moves_amazon integer,
  sold_warehouse integer,
  returned_warehouse integer,
  sold_fba integer,
  last_sale_date date
)
language sql
stable
security definer
set search_path = public
as $$
  with mappings as (
    select id from public.sku_mappings where account_id = p_account_id
  ),
  baseline as (
    select distinct on (l.sku_mapping_id)
      l.sku_mapping_id, l.level_date, l.updated_at, l.source, l.amazon_units, l.warehouse_units
    from public.inventory_levels l
    where l.account_id = p_account_id
    order by l.sku_mapping_id, l.level_date desc, l.updated_at desc
  ),
  moves as (
    select
      mv.sku_mapping_id,
      sum(case when mv.location = 'warehouse' then mv.units_delta else 0 end)::integer as moves_warehouse,
      sum(case when mv.location = 'amazon' then mv.units_delta else 0 end)::integer as moves_amazon
    from public.inventory_movements mv
    left join baseline b on b.sku_mapping_id = mv.sku_mapping_id
    where mv.account_id = p_account_id
      and mv.movement_type in ('po_receipt', 'fba_shipment_out', 'fba_received', 'customer_return', 'b2b_outbound', 'damaged', 'adjustment')
      and (b.sku_mapping_id is null or mv.created_at > b.updated_at + interval '5 seconds')
    group by mv.sku_mapping_id
  ),
  sales as (
    select
      d.sku_mapping_id,
      sum(case when d.platform = 'amazon' and d.channel = 'fba' then 0 else d.sold_units end)::integer as sold_warehouse,
      sum(case when d.platform = 'amazon' and d.channel = 'fba' then 0 else d.returns_units end)::integer as returned_warehouse,
      sum(case when d.platform = 'amazon' and d.channel = 'fba' then d.sold_units else 0 end)::integer as sold_fba,
      max(d.sale_date) as last_sale_date
    from public.inventory_daily_sales d
    left join baseline b on b.sku_mapping_id = d.sku_mapping_id
    where d.account_id = p_account_id
      and (b.sku_mapping_id is null or d.sale_date > b.level_date)
    group by d.sku_mapping_id
  )
  select
    m.id,
    b.level_date,
    b.updated_at,
    b.source,
    coalesce(b.amazon_units, 0),
    coalesce(b.warehouse_units, 0),
    coalesce(mv.moves_warehouse, 0),
    coalesce(mv.moves_amazon, 0),
    coalesce(s.sold_warehouse, 0),
    coalesce(s.returned_warehouse, 0),
    coalesce(s.sold_fba, 0),
    s.last_sale_date
  from mappings m
  left join baseline b on b.sku_mapping_id = m.id
  left join moves mv on mv.sku_mapping_id = m.id
  left join sales s on s.sku_mapping_id = m.id;
$$;

revoke all on function public.inventory_stock_position(uuid) from public, anon;
grant execute on function public.inventory_stock_position(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- inventory_demand_summary: units sold per SKU mapping and channel over the
-- trailing 7 / 30 / 90 / 365 days (ending yesterday, which is the last full
-- day). Amazon + Temu come from the facts cache; TikTok from the daily log.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_demand_summary(p_account_id uuid)
returns table (
  sku_mapping_id uuid,
  channel text,
  units_7 numeric,
  units_30 numeric,
  units_90 numeric,
  units_365 numeric,
  first_sale_date date,
  last_sale_date date
)
language sql
stable
security definer
set search_path = public
as $$
  with keys as (
    select sm.id,
      upper(trim(replace(sm.amazon_sku, chr(160), ' '))) as amazon_key,
      upper(trim(replace(sm.temu_sku_id, chr(160), ' '))) as temu_key
    from public.sku_mappings sm
    where sm.account_id = p_account_id
  ),
  facts as (
    select
      k.id as sku_mapping_id,
      case
        when lower(f.platform) like 'amazon%' then coalesce(f.channel, 'fbm')
        else 'temu'
      end as channel,
      f.sale_date,
      f.qty
    from public.inventory_sales_facts_cache f
    join keys k on (
      (lower(f.platform) like 'amazon%' and k.amazon_key = upper(trim(replace(coalesce(f.sku, ''), chr(160), ' '))))
      or (lower(f.platform) like 'temu%' and k.temu_key = upper(trim(replace(coalesce(f.sku, ''), chr(160), ' '))))
    )
    where f.account_id = p_account_id
      and f.qty > 0
      and f.sale_date >= current_date - 366
    union all
    select d.sku_mapping_id, 'tiktok', d.sale_date, d.sold_units
    from public.inventory_daily_sales d
    where d.account_id = p_account_id
      and d.platform = 'tiktok'
      and d.sold_units > 0
      and d.sale_date >= current_date - 366
  )
  select
    sku_mapping_id,
    channel,
    sum(case when sale_date >= current_date - 7 and sale_date < current_date then qty else 0 end),
    sum(case when sale_date >= current_date - 30 and sale_date < current_date then qty else 0 end),
    sum(case when sale_date >= current_date - 90 and sale_date < current_date then qty else 0 end),
    sum(case when sale_date >= current_date - 365 and sale_date < current_date then qty else 0 end),
    min(sale_date),
    max(sale_date)
  from facts
  group by sku_mapping_id, channel;
$$;

revoke all on function public.inventory_demand_summary(uuid) from public, anon;
grant execute on function public.inventory_demand_summary(uuid) to authenticated, service_role;

-- Daily units for the planner sparkline / trend (last 90 days, all channels).
create or replace function public.inventory_daily_units(p_account_id uuid, p_days integer default 90)
returns table (sku_mapping_id uuid, sale_date date, channel text, units numeric)
language sql
stable
security definer
set search_path = public
as $$
  with keys as (
    select sm.id,
      upper(trim(replace(sm.amazon_sku, chr(160), ' '))) as amazon_key,
      upper(trim(replace(sm.temu_sku_id, chr(160), ' '))) as temu_key
    from public.sku_mappings sm
    where sm.account_id = p_account_id
  )
  select k.id,
    f.sale_date,
    case when lower(f.platform) like 'amazon%' then coalesce(f.channel, 'fbm') else 'temu' end,
    sum(f.qty)
  from public.inventory_sales_facts_cache f
  join keys k on (
    (lower(f.platform) like 'amazon%' and k.amazon_key = upper(trim(replace(coalesce(f.sku, ''), chr(160), ' '))))
    or (lower(f.platform) like 'temu%' and k.temu_key = upper(trim(replace(coalesce(f.sku, ''), chr(160), ' '))))
  )
  where f.account_id = p_account_id
    and f.qty > 0
    and f.sale_date >= current_date - greatest(1, p_days)
  group by k.id, f.sale_date, 3
  union all
  select d.sku_mapping_id, d.sale_date, 'tiktok', sum(d.sold_units)
  from public.inventory_daily_sales d
  where d.account_id = p_account_id
    and d.platform = 'tiktok'
    and d.sold_units > 0
    and d.sale_date >= current_date - greatest(1, p_days)
  group by d.sku_mapping_id, d.sale_date;
$$;

revoke all on function public.inventory_daily_units(uuid, integer) from public, anon;
grant execute on function public.inventory_daily_units(uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Carry legacy shipment plans into the new documents so nothing is lost.
--   warehouse_requirement → purchase order (draft, or closed if converted)
--   amazon_requirement / manual → FBA shipment (draft, or closed if converted)
-- ---------------------------------------------------------------------------
insert into public.purchase_orders (
  account_id, po_number, status, order_date, notes, legacy_plan_id, created_by, closed_at, created_at, updated_at
)
select
  p.account_id,
  'PO-LEGACY-' || lpad((row_number() over (partition by p.account_id order by p.created_at))::text, 3, '0'),
  case when p.converted_at is not null then 'closed' else 'draft' end,
  p.plan_date,
  nullif(concat_ws(' — ', p.title, p.notes), ''),
  p.id,
  p.created_by,
  p.converted_at,
  p.created_at,
  p.updated_at
from public.shipment_plans p
where p.plan_type = 'warehouse_requirement'
  and not exists (select 1 from public.purchase_orders po where po.legacy_plan_id = p.id);

insert into public.purchase_order_items (purchase_order_id, sku_mapping_id, ordered_units, received_units, units_per_box, created_at)
select po.id, i.sku_mapping_id, i.planned_units,
  case when po.status = 'closed' then i.planned_units else 0 end,
  nullif(i.units_per_box, 0), i.created_at
from public.shipment_plan_items i
join public.purchase_orders po on po.legacy_plan_id = i.shipment_plan_id
where not exists (
  select 1 from public.purchase_order_items x where x.purchase_order_id = po.id and x.sku_mapping_id = i.sku_mapping_id
);

insert into public.fba_shipments (
  account_id, shipment_name, status, ship_date, notes, legacy_plan_id, created_by, shipped_at, closed_at, created_at, updated_at
)
select
  p.account_id,
  p.title,
  case when p.converted_at is not null then 'closed' else 'draft' end,
  p.plan_date,
  p.notes,
  p.id,
  p.created_by,
  p.converted_at,
  p.converted_at,
  p.created_at,
  p.updated_at
from public.shipment_plans p
where p.plan_type in ('amazon_requirement', 'manual')
  and not exists (select 1 from public.fba_shipments s where s.legacy_plan_id = p.id);

insert into public.fba_shipment_items (fba_shipment_id, sku_mapping_id, planned_units, sent_units, received_units, units_per_box, boxes, pallets, created_at)
select s.id, i.sku_mapping_id, i.planned_units,
  case when s.status = 'closed' then i.planned_units else 0 end,
  case when s.status = 'closed' then i.planned_units else 0 end,
  nullif(i.units_per_box, 0), nullif(i.planned_boxes, 0), nullif(i.pallets, 0), i.created_at
from public.shipment_plan_items i
join public.fba_shipments s on s.legacy_plan_id = i.shipment_plan_id
where not exists (
  select 1 from public.fba_shipment_items x where x.fba_shipment_id = s.id and x.sku_mapping_id = i.sku_mapping_id
);
