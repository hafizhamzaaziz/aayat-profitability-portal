-- Aayat Profitability Portal - Step 2 schema
-- Run this in Supabase SQL editor.
create extension if not exists "pgcrypto";
-- Roles enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE public.user_role AS ENUM ('admin', 'team', 'client');
  END IF;
END
$$;
-- Updated-at trigger helper
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
-- 1) users
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.user_role not null default 'client',
  full_name text not null,
  email text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 2) accounts
create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  currency text not null default '£',
  vat_rate numeric(5,2) not null default 20,
  assigned_team_id uuid references public.users(id) on delete set null,
  assigned_client_id uuid references public.users(id) on delete set null,
  logo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 2b) team-client mapping (multiple team members per client)
create table if not exists public.client_team_members (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.users(id) on delete cascade,
  team_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(client_id, team_id)
);
-- 2c) account-team mapping (multiple team members per account)
create table if not exists public.account_team_members (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  team_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(account_id, team_id)
);
-- 2d) account-client mapping (multiple client users per account)
create table if not exists public.account_client_members (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  client_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(account_id, client_id)
);
create index if not exists idx_account_client_members_account on public.account_client_members(account_id);
create index if not exists idx_account_client_members_client on public.account_client_members(client_id);
-- 2e) Amazon SP-API / Ads-API credentials per account (refresh_token encrypted with TOKEN_ENC_KEY)
-- One row per (account_id, provider). `provider` is 'sp-api' for Seller
-- Central data, 'ads-api' for Sponsored Products / Sponsored Brands data.
-- The two integrations use separate LWA apps, separate OAuth flows and
-- separate refresh tokens, so they're tracked independently.
create table if not exists public.account_amazon_credentials (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  provider text not null default 'sp-api',
  selling_partner_id text,
  marketplace_ids text[] not null default '{}',
  refresh_token_encrypted text not null,
  connected_at timestamptz not null default now(),
  connected_by uuid references public.users(id) on delete set null,
  last_synced_at timestamptz,
  last_sync_error text,
  unique(account_id, provider)
);
create index if not exists idx_account_amazon_credentials_account on public.account_amazon_credentials(account_id);
-- Ads-API specific: the Ads API exposes "profiles" which are per-marketplace
-- advertiser contexts (each profile has a profileId and a countryCode). We
-- store the selected profile per region as a JSON map so multi-marketplace
-- sellers can have GB / DE / FR profiles all under one credential row.
-- Example: {"GB": 1234567890, "DE": 9876543210}
alter table public.account_amazon_credentials add column if not exists ads_profile_ids jsonb not null default '{}'::jsonb;
-- Ads-API agency support: an agency credential can return many advertisers
-- (sellers) across every marketplace. We pin a single advertiser by name so
-- the per-country profile map only contains that advertiser's profiles.
alter table public.account_amazon_credentials add column if not exists ads_advertiser_name text;

-- TikTok Shop Open Platform (Partner API v2) credentials, one row per account.
-- Separate from Amazon: different OAuth app, signing scheme and token lifecycle.
-- TikTok rotates the refresh token on every refresh, so both tokens are stored
-- encrypted (AES-256-GCM via TOKEN_ENC_KEY) and re-persisted after each refresh.
create table if not exists public.account_tiktok_credentials (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  provider text not null default 'tiktok-shop',
  access_token_encrypted text,
  access_token_expires_at timestamptz,
  refresh_token_encrypted text not null,
  refresh_token_expires_at timestamptz,
  shop_cipher text,
  shop_id text,
  shop_name text,
  seller_name text,
  open_id text,
  region text,
  connected_at timestamptz not null default now(),
  connected_by uuid references public.users(id) on delete set null,
  last_synced_at timestamptz,
  last_sync_error text,
  unique(account_id, provider)
);
create index if not exists idx_account_tiktok_credentials_account on public.account_tiktok_credentials(account_id);

-- 3) cogs
create table if not exists public.cogs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  sku text not null,
  unit_cost numeric(12,2) not null,
  includes_vat boolean not null default false,
  effective_from date not null default current_date,
  updated_at timestamptz not null default now(),
  unique(account_id, sku)
);
alter table public.cogs add column if not exists includes_vat boolean not null default false;
alter table public.cogs add column if not exists effective_from date not null default current_date;
alter table public.cogs alter column effective_from set default current_date;

-- 3b) cogs history (versioned by effective date)
create table if not exists public.cogs_history (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  sku text not null,
  unit_cost numeric(12,2) not null,
  includes_vat boolean not null default false,
  effective_from date not null default current_date,
  changed_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(account_id, sku, effective_from)
);
alter table public.cogs_history alter column effective_from set default current_date;

-- Cleanup legacy placeholder dates.
update public.cogs
set effective_from = current_date
where effective_from = date '1970-01-01';

delete from public.cogs_history ch
where ch.effective_from = date '1970-01-01'
  and exists (
    select 1
    from public.cogs_history c2
    where c2.account_id = ch.account_id
      and c2.sku = ch.sku
      and c2.effective_from = current_date
  );

update public.cogs_history
set effective_from = current_date
where effective_from = date '1970-01-01';

-- Backfill a baseline history row for existing cogs rows.
insert into public.cogs_history (account_id, sku, unit_cost, includes_vat, effective_from, changed_by)
select c.account_id, c.sku, c.unit_cost, c.includes_vat, c.effective_from, auth.uid()
from public.cogs c
on conflict (account_id, sku, effective_from)
do update
set unit_cost = excluded.unit_cost,
    includes_vat = excluded.includes_vat;
-- 4) reports (aggregated totals only)
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  platform text not null check (platform in ('amazon', 'temu', 'tiktok')),
  gross_sales numeric(14,2) not null default 0,
  total_cogs numeric(14,2) not null default 0,
  total_fees numeric(14,2) not null default 0,
  output_vat numeric(14,2) not null default 0,
  input_vat numeric(14,2) not null default 0,
  net_profit numeric(14,2) not null default 0,
  breakdown jsonb,
  cogs_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id, period_start, period_end, platform, source)
);
alter table public.reports add column if not exists breakdown jsonb;
alter table public.reports add column if not exists cogs_snapshot jsonb;
alter table public.reports add column if not exists source text not null default 'manual';
create index if not exists idx_reports_account_source on public.reports(account_id, source);

-- 4b) parsed row-level report transactions (raw jsonb)
create table if not exists public.report_transactions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  platform text not null check (platform in ('amazon', 'temu', 'tiktok')),
  transaction_date date,
  sku text,
  quantity numeric(14,4),
  raw_row jsonb not null,
  source text not null default 'manual',
  amazon_event_id text,
  created_at timestamptz not null default now()
);
create index if not exists idx_report_transactions_account_amazon_event
  on public.report_transactions(account_id, amazon_event_id)
  where amazon_event_id is not null;
-- 5) expenses
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  description text not null,
  amount numeric(14,2) not null,
  includes_vat boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 5b) account-level expense ledger (used by reports for one-time + recurring)
create table if not exists public.expense_ledger (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  description text not null,
  expense_date date not null,
  amount numeric(14,2) not null,
  includes_vat boolean not null default false,
  marketplace text not null check (marketplace in ('amazon', 'temu', 'tiktok')),
  expense_type text not null default 'one_time' check (expense_type in ('one_time', 'recurring')),
  recurring_end_date date,
  source_legacy_expense_id uuid unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (recurring_end_date is null or recurring_end_date >= expense_date)
);
create index if not exists expense_ledger_account_marketplace_date_idx
  on public.expense_ledger(account_id, marketplace, expense_date);
create index if not exists expense_ledger_recurring_end_idx
  on public.expense_ledger(account_id, recurring_end_date)
  where expense_type = 'recurring';
-- 6) performance_metrics
create table if not exists public.performance_metrics (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  recorded_date date not null,
  product_name text not null,
  asin text,
  bsr integer,
  review_count integer,
  rating numeric(3,2),
  ppc_spend numeric(14,2),
  ppc_sales numeric(14,2),
  total_sales numeric(14,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.performance_metrics add column if not exists asin text;
alter table public.performance_metrics add column if not exists ppc_spend numeric(14,2);
alter table public.performance_metrics add column if not exists ppc_sales numeric(14,2);
alter table public.performance_metrics add column if not exists total_sales numeric(14,2);

-- 7) audit trail
create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.users(id) on delete set null,
  table_name text not null,
  entity_id text,
  action text not null check (action in ('insert', 'update', 'delete')),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

-- 8) notifications
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  body text not null default '',
  level text not null default 'info' check (level in ('info','warning','error','success')),
  link text,
  event_key text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists notifications_event_key_unique on public.notifications(event_key) where event_key is not null;

-- 9) inventory catalog and mappings
create table if not exists public.sku_catalog (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  product_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id, product_name)
);

create table if not exists public.sku_mappings (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  sku_catalog_id uuid not null references public.sku_catalog(id) on delete cascade,
  amazon_sku text,
  temu_sku_id text,
  tiktok_seller_sku text,
  lead_time_days integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (amazon_sku is not null or temu_sku_id is not null or tiktok_seller_sku is not null)
);
-- TikTok seller SKU (col G "Seller SKU" on the TikTok order export). Added to
-- bridge COGS lookups across Amazon ↔ Temu ↔ TikTok identifiers.
alter table public.sku_mappings add column if not exists tiktok_seller_sku text;
create unique index if not exists sku_mappings_amazon_unique
  on public.sku_mappings(account_id, amazon_sku) where amazon_sku is not null;
create unique index if not exists sku_mappings_temu_unique
  on public.sku_mappings(account_id, temu_sku_id) where temu_sku_id is not null;
create unique index if not exists sku_mappings_tiktok_unique
  on public.sku_mappings(account_id, tiktok_seller_sku) where tiktok_seller_sku is not null;

-- Optional link from COGS rows to canonical mapping.
alter table public.cogs add column if not exists sku_mapping_id uuid references public.sku_mappings(id) on delete set null;

-- Temu parent product identifier (Goods ID). One Goods ID groups many Temu
-- SKU IDs (variants). Used by the Temu ads-report flow to bucket per-Goods
-- ad spend and split within the bucket pro-rata to constituent SKUs.
alter table public.sku_catalog add column if not exists temu_goods_id text;
create index if not exists sku_catalog_temu_goods_id_idx
  on public.sku_catalog(account_id, temu_goods_id) where temu_goods_id is not null;

-- 10) inventory planning datasets
create table if not exists public.sku_monthly_sales (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  sku_mapping_id uuid not null references public.sku_mappings(id) on delete cascade,
  month_start date not null,
  amazon_units integer not null default 0,
  temu_units integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id, sku_mapping_id, month_start)
);

create table if not exists public.inventory_defaults (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  lead_time_days integer not null default 90,
  amazon_cover_days integer not null default 30,
  warehouse_cover_days integer not null default 120,
  storage_cost_per_pallet numeric(14,2) not null default 0,
  storage_cost_period text not null default 'month' check (storage_cost_period in ('week','month')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_levels (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  sku_mapping_id uuid not null references public.sku_mappings(id) on delete cascade,
  level_date date not null,
  amazon_units integer not null default 0,
  warehouse_units integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id, sku_mapping_id, level_date)
);

create table if not exists public.pack_profiles (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  profile_name text not null,
  units_per_box integer not null check (units_per_box > 0),
  box_length numeric(10,2) not null,
  box_width numeric(10,2) not null,
  box_height numeric(10,2) not null,
  dimension_unit text not null default 'cm' check (dimension_unit in ('mm','cm','in')),
  box_weight numeric(10,2),
  weight_unit text not null default 'kg' check (weight_unit in ('kg','lb')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  sku_mapping_id uuid not null references public.sku_mappings(id) on delete cascade,
  movement_date date not null,
  movement_type text not null check (movement_type in ('inbound','outbound','adjustment','amazon_transfer')),
  units_delta integer not null,
  boxes integer,
  pack_profile_id uuid references public.pack_profiles(id) on delete set null,
  notes text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.shipment_plans (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  plan_date date not null default current_date,
  plan_type text not null check (plan_type in ('amazon_requirement','warehouse_requirement','manual')),
  title text not null,
  notes text,
  orientation text not null default 'portrait' check (orientation in ('portrait','landscape')),
  converted_at timestamptz,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shipment_plan_items (
  id uuid primary key default gen_random_uuid(),
  shipment_plan_id uuid not null references public.shipment_plans(id) on delete cascade,
  sku_mapping_id uuid not null references public.sku_mappings(id) on delete cascade,
  suggested_units integer not null default 0,
  planned_units integer not null default 0,
  units_per_box integer not null default 1,
  planned_boxes integer not null default 0,
  pallets numeric(12,2) not null default 0,
  amazon_units_snapshot integer not null default 0,
  warehouse_units_snapshot integer not null default 0,
  lead_time_days integer,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_warehouses (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id, name)
);

create table if not exists public.inventory_daily_sales (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  sku_mapping_id uuid not null references public.sku_mappings(id) on delete cascade,
  sale_date date not null,
  platform text not null,
  warehouse_id uuid references public.inventory_warehouses(id) on delete set null,
  sold_units integer not null default 0,
  returns_units integer not null default 0,
  collected_units integer not null default 0,
  notes text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.inventory_daily_sales
  add column if not exists sold_units integer not null default 0;

-- performance and query indexes
create index if not exists reports_account_platform_period_idx on public.reports(account_id, platform, period_start, period_end);
create index if not exists reports_account_period_idx on public.reports(account_id, period_start, period_end);
create index if not exists report_transactions_report_idx on public.report_transactions(report_id);
create index if not exists report_transactions_account_platform_date_idx on public.report_transactions(account_id, platform, transaction_date);
create index if not exists report_transactions_sku_idx on public.report_transactions(account_id, sku);
create index if not exists cogs_history_account_sku_effective_idx on public.cogs_history(account_id, sku, effective_from desc);
create index if not exists sku_catalog_account_idx on public.sku_catalog(account_id, product_name);
create index if not exists sku_mappings_account_catalog_idx on public.sku_mappings(account_id, sku_catalog_id);
create index if not exists sku_monthly_sales_account_month_idx on public.sku_monthly_sales(account_id, month_start desc);
create index if not exists inventory_levels_account_date_idx on public.inventory_levels(account_id, level_date desc);
create index if not exists inventory_levels_mapping_date_idx on public.inventory_levels(sku_mapping_id, level_date desc);
create index if not exists inventory_movements_account_date_idx on public.inventory_movements(account_id, movement_date desc);
create index if not exists inventory_movements_mapping_date_idx on public.inventory_movements(sku_mapping_id, movement_date desc);
create index if not exists pack_profiles_account_idx on public.pack_profiles(account_id, profile_name);
create index if not exists shipment_plans_account_date_idx on public.shipment_plans(account_id, plan_date desc);
create index if not exists shipment_plan_items_plan_idx on public.shipment_plan_items(shipment_plan_id);
create index if not exists inventory_warehouses_account_name_idx on public.inventory_warehouses(account_id, name);
create index if not exists inventory_daily_sales_account_date_idx on public.inventory_daily_sales(account_id, sale_date desc);
create index if not exists inventory_daily_sales_mapping_date_idx on public.inventory_daily_sales(sku_mapping_id, sale_date desc);
create index if not exists performance_account_date_idx on public.performance_metrics(account_id, recorded_date desc);
create index if not exists expenses_report_idx on public.expenses(report_id);
create index if not exists notifications_user_read_created_idx on public.notifications(user_id, read_at, created_at desc);
create index if not exists audit_events_table_created_idx on public.audit_events(table_name, created_at desc);
create index if not exists audit_events_actor_created_idx on public.audit_events(actor_id, created_at desc);

-- Role helper for RLS checks (must come after users table exists)
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.users where id = auth.uid();
$$;
-- Used inside RLS policies (evaluated as the signed-in user); keep authenticated
-- only and keep it off the anonymous REST surface.
revoke execute on function public.current_user_role() from public, anon;
grant execute on function public.current_user_role() to authenticated;
-- triggers
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_users_updated_at') THEN
    CREATE TRIGGER set_users_updated_at BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_accounts_updated_at') THEN
    CREATE TRIGGER set_accounts_updated_at BEFORE UPDATE ON public.accounts
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_reports_updated_at') THEN
    CREATE TRIGGER set_reports_updated_at BEFORE UPDATE ON public.reports
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_expenses_updated_at') THEN
    CREATE TRIGGER set_expenses_updated_at BEFORE UPDATE ON public.expenses
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_expense_ledger_updated_at') THEN
    CREATE TRIGGER set_expense_ledger_updated_at BEFORE UPDATE ON public.expense_ledger
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_performance_metrics_updated_at') THEN
    CREATE TRIGGER set_performance_metrics_updated_at BEFORE UPDATE ON public.performance_metrics
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_cogs_updated_at') THEN
    CREATE TRIGGER set_cogs_updated_at BEFORE UPDATE ON public.cogs
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_sku_catalog_updated_at') THEN
    CREATE TRIGGER set_sku_catalog_updated_at BEFORE UPDATE ON public.sku_catalog
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_sku_mappings_updated_at') THEN
    CREATE TRIGGER set_sku_mappings_updated_at BEFORE UPDATE ON public.sku_mappings
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_sku_monthly_sales_updated_at') THEN
    CREATE TRIGGER set_sku_monthly_sales_updated_at BEFORE UPDATE ON public.sku_monthly_sales
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_inventory_defaults_updated_at') THEN
    CREATE TRIGGER set_inventory_defaults_updated_at BEFORE UPDATE ON public.inventory_defaults
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_inventory_levels_updated_at') THEN
    CREATE TRIGGER set_inventory_levels_updated_at BEFORE UPDATE ON public.inventory_levels
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_pack_profiles_updated_at') THEN
    CREATE TRIGGER set_pack_profiles_updated_at BEFORE UPDATE ON public.pack_profiles
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_inventory_warehouses_updated_at') THEN
    CREATE TRIGGER set_inventory_warehouses_updated_at BEFORE UPDATE ON public.inventory_warehouses
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_inventory_daily_sales_updated_at') THEN
    CREATE TRIGGER set_inventory_daily_sales_updated_at BEFORE UPDATE ON public.inventory_daily_sales
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_shipment_plans_updated_at') THEN
    CREATE TRIGGER set_shipment_plans_updated_at BEFORE UPDATE ON public.shipment_plans
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;
-- RLS enable
alter table public.users enable row level security;
alter table public.accounts enable row level security;
alter table public.client_team_members enable row level security;
alter table public.account_team_members enable row level security;
alter table public.account_client_members enable row level security;
alter table public.account_amazon_credentials enable row level security;
alter table public.account_tiktok_credentials enable row level security;
alter table public.cogs enable row level security;
alter table public.cogs_history enable row level security;
alter table public.sku_catalog enable row level security;
alter table public.sku_mappings enable row level security;
alter table public.sku_monthly_sales enable row level security;
alter table public.inventory_defaults enable row level security;
alter table public.inventory_levels enable row level security;
alter table public.pack_profiles enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.inventory_warehouses enable row level security;
alter table public.inventory_daily_sales enable row level security;
alter table public.shipment_plans enable row level security;
alter table public.shipment_plan_items enable row level security;
alter table public.reports enable row level security;
alter table public.report_transactions enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_ledger enable row level security;
alter table public.performance_metrics enable row level security;
alter table public.audit_events enable row level security;
alter table public.notifications enable row level security;
-- users policies
drop policy if exists "users_select_self_or_staff" on public.users;
create policy "users_select_self_or_staff"
on public.users
for select
to authenticated
using (auth.uid() = id or public.current_user_role() in ('admin', 'team'));

drop policy if exists "users_update_self_or_admin" on public.users;
create policy "users_update_self_or_admin"
on public.users
for update
to authenticated
using (auth.uid() = id or public.current_user_role() = 'admin')
with check (auth.uid() = id or public.current_user_role() = 'admin');

drop policy if exists "users_insert_admin_only" on public.users;
create policy "users_insert_admin_only"
on public.users
for insert
to authenticated
with check (public.current_user_role() = 'admin');

-- accounts policies
drop policy if exists "accounts_select_authenticated" on public.accounts;
create policy "accounts_select_authenticated"
on public.accounts
for select
to authenticated
using (true);

drop policy if exists "accounts_modify_admin_team" on public.accounts;
create policy "accounts_modify_admin_team"
on public.accounts
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

-- client_team_members policies
drop policy if exists "client_team_members_select_authenticated" on public.client_team_members;
create policy "client_team_members_select_authenticated"
on public.client_team_members
for select
to authenticated
using (true);

drop policy if exists "client_team_members_modify_admin_only" on public.client_team_members;
create policy "client_team_members_modify_admin_only"
on public.client_team_members
for all
to authenticated
using (public.current_user_role() = 'admin')
with check (public.current_user_role() = 'admin');

-- account_team_members policies
drop policy if exists "account_team_members_select_authenticated" on public.account_team_members;
create policy "account_team_members_select_authenticated"
on public.account_team_members
for select
to authenticated
using (true);

drop policy if exists "account_team_members_modify_admin_only" on public.account_team_members;
create policy "account_team_members_modify_admin_only"
on public.account_team_members
for all
to authenticated
using (public.current_user_role() = 'admin')
with check (public.current_user_role() = 'admin');

-- account_client_members policies
drop policy if exists "account_client_members_select_authenticated" on public.account_client_members;
create policy "account_client_members_select_authenticated"
on public.account_client_members
for select
to authenticated
using (true);

drop policy if exists "account_client_members_modify_admin_only" on public.account_client_members;
create policy "account_client_members_modify_admin_only"
on public.account_client_members
for all
to authenticated
using (public.current_user_role() = 'admin')
with check (public.current_user_role() = 'admin');

-- account_amazon_credentials policies
drop policy if exists "account_amazon_credentials_select_staff" on public.account_amazon_credentials;
create policy "account_amazon_credentials_select_staff"
on public.account_amazon_credentials
for select
to authenticated
using (public.current_user_role() in ('admin', 'team'));

drop policy if exists "account_amazon_credentials_modify_admin_only" on public.account_amazon_credentials;
create policy "account_amazon_credentials_modify_admin_only"
on public.account_amazon_credentials
for all
to authenticated
using (public.current_user_role() = 'admin')
with check (public.current_user_role() = 'admin');

-- account_tiktok_credentials policies
drop policy if exists "account_tiktok_credentials_select_staff" on public.account_tiktok_credentials;
create policy "account_tiktok_credentials_select_staff"
on public.account_tiktok_credentials
for select
to authenticated
using (public.current_user_role() in ('admin', 'team'));

drop policy if exists "account_tiktok_credentials_modify_admin_only" on public.account_tiktok_credentials;
create policy "account_tiktok_credentials_modify_admin_only"
on public.account_tiktok_credentials
for all
to authenticated
using (public.current_user_role() = 'admin')
with check (public.current_user_role() = 'admin');

-- cogs policies
drop policy if exists "cogs_select_authenticated" on public.cogs;
create policy "cogs_select_authenticated"
on public.cogs
for select
to authenticated
using (true);

drop policy if exists "cogs_modify_admin_team" on public.cogs;
create policy "cogs_modify_admin_team"
on public.cogs
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

-- cogs_history policies
drop policy if exists "cogs_history_select_authenticated" on public.cogs_history;
create policy "cogs_history_select_authenticated"
on public.cogs_history
for select
to authenticated
using (true);

drop policy if exists "cogs_history_modify_admin_team" on public.cogs_history;
create policy "cogs_history_modify_admin_team"
on public.cogs_history
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

-- inventory catalog and planning policies
drop policy if exists "sku_catalog_select_authenticated" on public.sku_catalog;
create policy "sku_catalog_select_authenticated"
on public.sku_catalog
for select
to authenticated
using (true);

drop policy if exists "sku_catalog_modify_admin_team" on public.sku_catalog;
create policy "sku_catalog_modify_admin_team"
on public.sku_catalog
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

drop policy if exists "sku_mappings_select_authenticated" on public.sku_mappings;
create policy "sku_mappings_select_authenticated"
on public.sku_mappings
for select
to authenticated
using (true);

drop policy if exists "sku_mappings_modify_admin_team" on public.sku_mappings;
create policy "sku_mappings_modify_admin_team"
on public.sku_mappings
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

drop policy if exists "sku_monthly_sales_select_authenticated" on public.sku_monthly_sales;
create policy "sku_monthly_sales_select_authenticated"
on public.sku_monthly_sales
for select
to authenticated
using (true);

drop policy if exists "sku_monthly_sales_modify_admin_team" on public.sku_monthly_sales;
create policy "sku_monthly_sales_modify_admin_team"
on public.sku_monthly_sales
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

drop policy if exists "inventory_defaults_select_authenticated" on public.inventory_defaults;
create policy "inventory_defaults_select_authenticated"
on public.inventory_defaults
for select
to authenticated
using (true);

drop policy if exists "inventory_defaults_modify_admin_team" on public.inventory_defaults;
create policy "inventory_defaults_modify_admin_team"
on public.inventory_defaults
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

drop policy if exists "inventory_levels_select_authenticated" on public.inventory_levels;
create policy "inventory_levels_select_authenticated"
on public.inventory_levels
for select
to authenticated
using (true);

drop policy if exists "inventory_levels_modify_admin_team" on public.inventory_levels;
create policy "inventory_levels_modify_admin_team"
on public.inventory_levels
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

drop policy if exists "pack_profiles_select_authenticated" on public.pack_profiles;
create policy "pack_profiles_select_authenticated"
on public.pack_profiles
for select
to authenticated
using (true);

drop policy if exists "pack_profiles_modify_admin_team" on public.pack_profiles;
create policy "pack_profiles_modify_admin_team"
on public.pack_profiles
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

drop policy if exists "inventory_movements_select_authenticated" on public.inventory_movements;
create policy "inventory_movements_select_authenticated"
on public.inventory_movements
for select
to authenticated
using (true);

drop policy if exists "inventory_movements_modify_admin_team" on public.inventory_movements;
create policy "inventory_movements_modify_admin_team"
on public.inventory_movements
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

drop policy if exists "inventory_warehouses_select_authenticated" on public.inventory_warehouses;
create policy "inventory_warehouses_select_authenticated"
on public.inventory_warehouses
for select
to authenticated
using (true);

drop policy if exists "inventory_warehouses_modify_admin_team" on public.inventory_warehouses;
create policy "inventory_warehouses_modify_admin_team"
on public.inventory_warehouses
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

drop policy if exists "inventory_daily_sales_select_authenticated" on public.inventory_daily_sales;
create policy "inventory_daily_sales_select_authenticated"
on public.inventory_daily_sales
for select
to authenticated
using (true);

drop policy if exists "inventory_daily_sales_modify_admin_team" on public.inventory_daily_sales;
create policy "inventory_daily_sales_modify_admin_team"
on public.inventory_daily_sales
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

drop policy if exists "shipment_plans_select_authenticated" on public.shipment_plans;
create policy "shipment_plans_select_authenticated"
on public.shipment_plans
for select
to authenticated
using (true);

drop policy if exists "shipment_plans_modify_admin_team" on public.shipment_plans;
create policy "shipment_plans_modify_admin_team"
on public.shipment_plans
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

drop policy if exists "shipment_plan_items_select_authenticated" on public.shipment_plan_items;
create policy "shipment_plan_items_select_authenticated"
on public.shipment_plan_items
for select
to authenticated
using (true);

drop policy if exists "shipment_plan_items_modify_admin_team" on public.shipment_plan_items;
create policy "shipment_plan_items_modify_admin_team"
on public.shipment_plan_items
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

-- reports policies
drop policy if exists "reports_select_authenticated" on public.reports;
create policy "reports_select_authenticated"
on public.reports
for select
to authenticated
using (true);

drop policy if exists "reports_modify_admin_team" on public.reports;
create policy "reports_modify_admin_team"
on public.reports
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

-- report_transactions policies
drop policy if exists "report_transactions_select_authenticated" on public.report_transactions;
create policy "report_transactions_select_authenticated"
on public.report_transactions
for select
to authenticated
using (true);

drop policy if exists "report_transactions_modify_admin_team" on public.report_transactions;
create policy "report_transactions_modify_admin_team"
on public.report_transactions
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

-- expenses policies
drop policy if exists "expenses_select_authenticated" on public.expenses;
create policy "expenses_select_authenticated"
on public.expenses
for select
to authenticated
using (true);

drop policy if exists "expenses_modify_admin_team" on public.expenses;
create policy "expenses_modify_admin_team"
on public.expenses
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

-- expense_ledger policies
drop policy if exists "expense_ledger_select_authenticated" on public.expense_ledger;
create policy "expense_ledger_select_authenticated"
on public.expense_ledger
for select
to authenticated
using (true);

drop policy if exists "expense_ledger_modify_admin_team" on public.expense_ledger;
create policy "expense_ledger_modify_admin_team"
on public.expense_ledger
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

-- performance policies
drop policy if exists "performance_select_authenticated" on public.performance_metrics;
create policy "performance_select_authenticated"
on public.performance_metrics
for select
to authenticated
using (true);

drop policy if exists "performance_modify_admin_team" on public.performance_metrics;
create policy "performance_modify_admin_team"
on public.performance_metrics
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

-- audit policies
drop policy if exists "audit_events_select_admin_only" on public.audit_events;
create policy "audit_events_select_admin_only"
on public.audit_events
for select
to authenticated
using (public.current_user_role() = 'admin');

-- notifications policies
drop policy if exists "notifications_select_own_or_admin" on public.notifications;
create policy "notifications_select_own_or_admin"
on public.notifications
for select
to authenticated
using (auth.uid() = user_id or public.current_user_role() = 'admin');

drop policy if exists "notifications_insert_own_or_staff" on public.notifications;
create policy "notifications_insert_own_or_staff"
on public.notifications
for insert
to authenticated
with check (auth.uid() = user_id or public.current_user_role() in ('admin','team'));

drop policy if exists "notifications_update_own_or_admin" on public.notifications;
create policy "notifications_update_own_or_admin"
on public.notifications
for update
to authenticated
using (auth.uid() = user_id or public.current_user_role() = 'admin')
with check (auth.uid() = user_id or public.current_user_role() = 'admin');

drop policy if exists "notifications_delete_admin_only" on public.notifications;
create policy "notifications_delete_admin_only"
on public.notifications
for delete
to authenticated
using (public.current_user_role() = 'admin');

-- Storage bucket (public) for account logos
insert into storage.buckets (id, name, public)
values ('account_logos', 'account_logos', true)
on conflict (id) do nothing;

-- Storage object policies
-- NOTE: a public bucket serves objects via their public URL without any SELECT
-- policy on storage.objects. We intentionally do NOT add a broad "public read"
-- SELECT policy here because it would let anyone *list* every file in the
-- bucket (flagged by the linter as public_bucket_allows_listing).
drop policy if exists "account_logos_public_read" on storage.objects;

drop policy if exists "account_logos_insert_admin_team" on storage.objects;
create policy "account_logos_insert_admin_team"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'account_logos' and public.current_user_role() in ('admin', 'team'));

drop policy if exists "account_logos_update_admin_team" on storage.objects;
create policy "account_logos_update_admin_team"
on storage.objects
for update
to authenticated
using (bucket_id = 'account_logos' and public.current_user_role() in ('admin', 'team'))
with check (bucket_id = 'account_logos' and public.current_user_role() in ('admin', 'team'));

drop policy if exists "account_logos_delete_admin_team" on storage.objects;
create policy "account_logos_delete_admin_team"
on storage.objects
for delete
to authenticated
using (bucket_id = 'account_logos' and public.current_user_role() in ('admin', 'team'));

-- IMPORTANT (manual setting in dashboard):
-- Disable public signup in Supabase Auth settings:
-- Authentication -> Providers -> Email -> Disable "Enable email signups".

-- audit trigger helper
create or replace function public.log_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid;
  target_id text;
begin
  actor := auth.uid();
  if (TG_OP = 'INSERT') then
    target_id := coalesce((to_jsonb(NEW)->>'id'), null);
    insert into public.audit_events(actor_id, table_name, entity_id, action, before_data, after_data)
    values (actor, TG_TABLE_NAME, target_id, 'insert', null, to_jsonb(NEW));
    return NEW;
  elsif (TG_OP = 'UPDATE') then
    target_id := coalesce((to_jsonb(NEW)->>'id'), (to_jsonb(OLD)->>'id'), null);
    insert into public.audit_events(actor_id, table_name, entity_id, action, before_data, after_data)
    values (actor, TG_TABLE_NAME, target_id, 'update', to_jsonb(OLD), to_jsonb(NEW));
    return NEW;
  elsif (TG_OP = 'DELETE') then
    target_id := coalesce((to_jsonb(OLD)->>'id'), null);
    insert into public.audit_events(actor_id, table_name, entity_id, action, before_data, after_data)
    values (actor, TG_TABLE_NAME, target_id, 'delete', to_jsonb(OLD), null);
    return OLD;
  end if;
  return null;
end;
$$;
-- This is a trigger-only helper: triggers fire it regardless of EXECUTE grants,
-- so no role should be able to call it directly via the REST API.
revoke execute on function public.log_audit_event() from public, anon, authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_accounts_changes') THEN
    CREATE TRIGGER audit_accounts_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.accounts
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_users_changes') THEN
    CREATE TRIGGER audit_users_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_reports_changes') THEN
    CREATE TRIGGER audit_reports_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.reports
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  -- Intentionally NOT auditing public.report_transactions.
  -- Each report upload inserts thousands of rows; the audit copy would
  -- balloon the database (we hit ~929 MB of audit_events from this one trigger).
  -- The reports themselves are the source of truth; per-row audit is noise.
  DROP TRIGGER IF EXISTS audit_report_transactions_changes ON public.report_transactions;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_expenses_changes') THEN
    CREATE TRIGGER audit_expenses_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.expenses
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_performance_changes') THEN
    CREATE TRIGGER audit_performance_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.performance_metrics
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_cogs_changes') THEN
    CREATE TRIGGER audit_cogs_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.cogs
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_cogs_history_changes') THEN
    CREATE TRIGGER audit_cogs_history_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.cogs_history
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_sku_catalog_changes') THEN
    CREATE TRIGGER audit_sku_catalog_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.sku_catalog
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_sku_mappings_changes') THEN
    CREATE TRIGGER audit_sku_mappings_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.sku_mappings
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_sku_monthly_sales_changes') THEN
    CREATE TRIGGER audit_sku_monthly_sales_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.sku_monthly_sales
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_inventory_defaults_changes') THEN
    CREATE TRIGGER audit_inventory_defaults_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.inventory_defaults
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_inventory_levels_changes') THEN
    CREATE TRIGGER audit_inventory_levels_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.inventory_levels
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_pack_profiles_changes') THEN
    CREATE TRIGGER audit_pack_profiles_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.pack_profiles
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_inventory_movements_changes') THEN
    CREATE TRIGGER audit_inventory_movements_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.inventory_movements
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_shipment_plans_changes') THEN
    CREATE TRIGGER audit_shipment_plans_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.shipment_plans
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_shipment_plan_items_changes') THEN
    CREATE TRIGGER audit_shipment_plan_items_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.shipment_plan_items
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 11) Per-SKU profitability breakdown for each saved report
--     One row per (report, SKU). Powers the per-SKU table in the workbench
--     and saved-reports panel. All amounts ex-VAT, signs follow P&L
--     convention (cost components negative).
-- ---------------------------------------------------------------------------
create table if not exists public.report_sku_breakdowns (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  sku text not null,
  description text,
  units numeric(14,4) not null default 0,
  refund_units numeric(14,4) not null default 0,
  product_sales numeric(14,2) not null default 0,
  postage_credits numeric(14,2) not null default 0,
  promo_rebates numeric(14,2) not null default 0,
  net_sales numeric(14,2) not null default 0,
  cogs numeric(14,2) not null default 0,
  selling_fees_exvat numeric(14,2) not null default 0,
  fba_fees_exvat numeric(14,2) not null default 0,
  other_tx_fees_exvat numeric(14,2) not null default 0,
  delivery_services_exvat numeric(14,2) not null default 0,
  advertising_alloc numeric(14,2) not null default 0,
  fba_inventory_alloc numeric(14,2) not null default 0,
  subscription_alloc numeric(14,2) not null default 0,
  deal_fees_alloc numeric(14,2) not null default 0,
  fba_reimbursements numeric(14,2) not null default 0,
  output_vat numeric(14,2) not null default 0,
  marketplace_withheld_vat numeric(14,2) not null default 0,
  retrocharge_vat numeric(14,2) not null default 0,
  net_profit numeric(14,2) not null default 0,
  cost_known boolean not null default false,
  ad_only boolean not null default false,
  created_at timestamptz not null default now(),
  unique(report_id, sku)
);

-- ---------------------------------------------------------------------------
-- 12) Ads-report metadata (one row per saved report when an ads file was
--     uploaded). Replaces the transaction-sheet 'Cost of Advertising' line
--     so account totals + per-SKU view stay consistent.
-- ---------------------------------------------------------------------------
create table if not exists public.report_ad_meta (
  report_id uuid primary key references public.reports(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  source_filename text,
  total_spend_exvat numeric(14,2) not null default 0,
  blank_sku_spend numeric(14,2) not null default 0,
  matched_sku_count integer not null default 0,
  unmatched_sku_count integer not null default 0,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references public.users(id) on delete set null
);

-- ---------------------------------------------------------------------------
-- 13) Per-SKU ads spend rows from the uploaded ads report. Persisted so the
--     report can be re-rendered without re-uploading.
-- ---------------------------------------------------------------------------
create table if not exists public.report_ad_spend (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  sku text,                          -- nullable: blank-SKU rows (e.g. SB keyword campaigns)
  spend_exvat numeric(14,2) not null,
  matched boolean not null default false,
  created_at timestamptz not null default now()
);

-- Temu ads-report support: when persisting a Temu ads upload, rows are stored
-- one-per-Goods (the dashboard's natural granularity). The per-SKU allocation
-- is recomputed at render-time from `temu_goods_id` + the sku_mappings table.
alter table public.report_ad_spend add column if not exists temu_goods_id text;
alter table public.report_ad_spend add column if not exists goods_name text;
alter table public.report_ad_spend add column if not exists source_kind text;
-- source_kind values: 'amazon_sku' (default for Amazon) | 'temu_goods' (Temu)

-- ---------------------------------------------------------------------------
-- 13b) Amazon Ads-API async report jobs.
--   Ads Reports v3 generation is asynchronous and can take several minutes,
--   especially when many reports are requested at once (Amazon throttles
--   concurrent generation). We therefore decouple requesting from collecting:
--     1. /sync requests a report per (profile, <=31-day window), inserting one
--        job row per report with status='requested' and the amazon_report_id.
--     2. /collect (auto-polled from the UI + a Vercel cron) polls each report,
--        downloads completed ones, pre-aggregates the rows by (month, SKU) into
--        `aggregate`, and flips status to 'completed'/'failed'.
--     3. When a batch has no more 'requested'/'completed-not-ingested' jobs,
--        the aggregates are merged by month and folded into report_ad_meta /
--        report_ad_spend, then jobs flip to 'ingested'.
--   `aggregate` jsonb shape: { "2026-04": { spendBySku: {sku: n}, blankSkuSpend: n, totalSpend: n } }
-- ---------------------------------------------------------------------------
create table if not exists public.ads_report_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  batch_id uuid not null,
  profile_id text not null,
  country_code text not null,
  start_date date not null,
  end_date date not null,
  amazon_report_id text,
  status text not null default 'requested', -- requested | completed | failed | ingested
  rows_downloaded integer not null default 0,
  aggregate jsonb,
  error text,
  vat_rate_pct numeric(6,2) not null default 20,
  cogs_vat_reclaim_pct numeric(6,2) not null default 100,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ads_report_jobs_batch_idx on public.ads_report_jobs(batch_id);
create index if not exists ads_report_jobs_status_idx on public.ads_report_jobs(status);
create index if not exists ads_report_jobs_account_idx on public.ads_report_jobs(account_id);
alter table public.ads_report_jobs enable row level security;
drop policy if exists "ads_report_jobs_select_staff" on public.ads_report_jobs;
create policy "ads_report_jobs_select_staff" on public.ads_report_jobs for select using (
  exists (select 1 from public.users u where u.id = auth.uid() and u.role in ('admin','team'))
);
-- Writes happen exclusively via the service-role admin client (sync/collect
-- orchestrators), which bypasses RLS, so no insert/update policy is needed.

-- Indexes for the new tables
create index if not exists report_sku_breakdowns_report_idx on public.report_sku_breakdowns(report_id);
create index if not exists report_sku_breakdowns_account_sku_idx on public.report_sku_breakdowns(account_id, sku);
create index if not exists report_ad_spend_report_idx on public.report_ad_spend(report_id);
create index if not exists report_ad_spend_account_sku_idx on public.report_ad_spend(account_id, sku);
create index if not exists report_ad_spend_temu_goods_idx on public.report_ad_spend(report_id, temu_goods_id) where temu_goods_id is not null;

-- RLS for the new tables (mirrors reports/expenses: read for all authenticated, write for admin/team)
alter table public.report_sku_breakdowns enable row level security;
alter table public.report_ad_meta enable row level security;
alter table public.report_ad_spend enable row level security;

drop policy if exists "report_sku_breakdowns_select_authenticated" on public.report_sku_breakdowns;
create policy "report_sku_breakdowns_select_authenticated"
on public.report_sku_breakdowns
for select
to authenticated
using (true);

drop policy if exists "report_sku_breakdowns_modify_admin_team" on public.report_sku_breakdowns;
create policy "report_sku_breakdowns_modify_admin_team"
on public.report_sku_breakdowns
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

drop policy if exists "report_ad_meta_select_authenticated" on public.report_ad_meta;
create policy "report_ad_meta_select_authenticated"
on public.report_ad_meta
for select
to authenticated
using (true);

drop policy if exists "report_ad_meta_modify_admin_team" on public.report_ad_meta;
create policy "report_ad_meta_modify_admin_team"
on public.report_ad_meta
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

drop policy if exists "report_ad_spend_select_authenticated" on public.report_ad_spend;
create policy "report_ad_spend_select_authenticated"
on public.report_ad_spend
for select
to authenticated
using (true);

drop policy if exists "report_ad_spend_modify_admin_team" on public.report_ad_spend;
create policy "report_ad_spend_modify_admin_team"
on public.report_ad_spend
for all
to authenticated
using (public.current_user_role() in ('admin', 'team'))
with check (public.current_user_role() in ('admin', 'team'));

-- Audit triggers for the new tables
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_report_sku_breakdowns_changes') THEN
    CREATE TRIGGER audit_report_sku_breakdowns_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.report_sku_breakdowns
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_report_ad_meta_changes') THEN
    CREATE TRIGGER audit_report_ad_meta_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.report_ad_meta
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_report_ad_spend_changes') THEN
    CREATE TRIGGER audit_report_ad_spend_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.report_ad_spend
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 14) COGS-VAT reclaim percentage
--   Percentage of inventory bought from UK VAT-registered suppliers; applied
--   on top of ex-VAT COGS as reclaimable Input VAT. Default 100 (matches the
--   prior portal behaviour where 20% of total COGS was always reclaimed).
--   Per-account default + per-report override.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'cogs_vat_reclaim_pct'
  ) THEN
    ALTER TABLE public.accounts
      ADD COLUMN cogs_vat_reclaim_pct numeric(5,2) NOT NULL DEFAULT 100;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'reports' AND column_name = 'cogs_vat_reclaim_pct'
  ) THEN
    ALTER TABLE public.reports
      ADD COLUMN cogs_vat_reclaim_pct numeric(5,2);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 15) Amazon Daily Sales sync from SP-API facts cache
--   Overview velocity reads inventory_sales_facts_cache. Daily Sales is the
--   warehouse-dispatch log. This copies Amazon units into inventory_daily_sales
--   (Sportive default warehouse) without overwriting warehouse edits.
-- ---------------------------------------------------------------------------
alter table public.inventory_daily_sales
  add column if not exists source text not null default 'manual';

create index if not exists inventory_daily_sales_account_key_idx
  on public.inventory_daily_sales (account_id, sku_mapping_id, sale_date, platform);

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

  create temporary table if not exists _amazon_daily_facts (
    sku_mapping_id uuid not null,
    sale_date date not null,
    sold_units integer not null,
    primary key (sku_mapping_id, sale_date)
  ) on commit drop;
  truncate _amazon_daily_facts;

  insert into _amazon_daily_facts (sku_mapping_id, sale_date, sold_units)
  select
    m.id,
    f.sale_date,
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
  group by m.id, f.sale_date
  having round(sum(f.qty)) > 0;

  insert into public.inventory_daily_sales (
    account_id,
    sku_mapping_id,
    sale_date,
    platform,
    warehouse_id,
    sold_units,
    returns_units,
    collected_units,
    notes,
    source
  )
  select
    p_account_id,
    f.sku_mapping_id,
    f.sale_date,
    'amazon',
    v_warehouse_id,
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
  );
  get diagnostics v_inserted = row_count;

  update public.inventory_daily_sales d
  set
    sold_units = f.sold_units,
    warehouse_id = coalesce(d.warehouse_id, v_warehouse_id),
    source = case when d.source = 'manual' then d.source else 'sp_api' end,
    updated_at = now()
  from _amazon_daily_facts f
  join (
    select sku_mapping_id, sale_date
    from public.inventory_daily_sales
    where account_id = p_account_id
      and platform = 'amazon'
      and (p_from is null or sale_date >= p_from)
      and (p_to is null or sale_date <= p_to)
    group by sku_mapping_id, sale_date
    having count(*) = 1
  ) k on k.sku_mapping_id = f.sku_mapping_id and k.sale_date = f.sale_date
  where d.account_id = p_account_id
    and d.platform = 'amazon'
    and d.sku_mapping_id = f.sku_mapping_id
    and d.sale_date = f.sale_date
    and (
      d.sold_units is distinct from f.sold_units
      or (d.warehouse_id is null and v_warehouse_id is not null)
    );
  get diagnostics v_updated = row_count;

  update public.inventory_daily_sales d
  set warehouse_id = v_warehouse_id, updated_at = now()
  where d.account_id = p_account_id
    and d.platform = 'amazon'
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

-- Sellerboard-style Amazon dashboard snapshots + catalog identifiers
alter table public.account_amazon_credentials
  add column if not exists finance_synced_through date;

alter table public.sku_mappings
  add column if not exists amazon_asin text,
  add column if not exists parent_asin text;

alter table public.performance_metrics
  add column if not exists source text not null default 'manual';

create table if not exists public.amazon_dashboard_snapshots (
  account_id uuid not null references public.accounts(id) on delete cascade,
  preset text not null,
  period_start date not null,
  period_end date not null,
  metrics jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  primary key (account_id, preset)
);
alter table public.amazon_dashboard_snapshots enable row level security;
drop policy if exists "amazon_dashboard_snapshots_all" on public.amazon_dashboard_snapshots;
create policy "amazon_dashboard_snapshots_all"
on public.amazon_dashboard_snapshots
for all
using (true)
with check (true);



-- =====================================================================
-- 2026-10-01 Inventory v2 (see supabase/migrations/20261001_inventory_v2.sql)
-- =====================================================================
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


-- =====================================================================
-- 2026-10-02 Amazon listings catalog (supabase/migrations/20261002_amazon_listings.sql)
-- =====================================================================
-- Amazon listings catalog pulled from the SP-API "All Listings" report
-- (GET_MERCHANT_LISTINGS_ALL_DATA), one row per marketplace × seller SKU.
-- Lets the portal know every SKU/ASIN the seller has, not only the ones that
-- appear in sales transactions.

create table if not exists public.amazon_listings (
  account_id uuid not null references public.accounts(id) on delete cascade,
  marketplace_id text not null,
  seller_sku text not null,
  asin text,
  listing_id text,
  title text,
  price numeric(12,2),
  quantity integer,
  fulfillment_channel text,            -- 'fba' | 'fbm'
  status text,                          -- Active | Inactive | Incomplete
  condition text,
  open_date date,
  image_url text,
  synced_at timestamptz not null default now(),
  primary key (account_id, marketplace_id, seller_sku)
);
create index if not exists amazon_listings_account_sku_idx on public.amazon_listings(account_id, seller_sku);
create index if not exists amazon_listings_account_asin_idx on public.amazon_listings(account_id, asin) where asin is not null;

alter table public.amazon_listings enable row level security;
drop policy if exists amazon_listings_select_authenticated on public.amazon_listings;
create policy amazon_listings_select_authenticated on public.amazon_listings for select to authenticated using (true);
drop policy if exists amazon_listings_modify_admin_team on public.amazon_listings;
create policy amazon_listings_modify_admin_team on public.amazon_listings for all to authenticated
  using (public.current_user_role() in ('admin', 'team')) with check (public.current_user_role() in ('admin', 'team'));

-- When the listings catalog was last refreshed for the account.
alter table public.account_amazon_credentials add column if not exists listings_synced_at timestamptz;
alter table public.account_amazon_credentials add column if not exists listings_sync_error text;

-- Mapping rows created from the listings report are tagged so the UI can
-- show which products were auto-discovered vs. entered by hand.
alter table public.sku_mappings add column if not exists amazon_asin text;
alter table public.sku_mappings add column if not exists amazon_title text;
alter table public.sku_mappings add column if not exists source text not null default 'manual';


-- =====================================================================
-- 2026-10-02 pg_cron scheduling (supabase/migrations/20261002_portal_pg_cron.sql)
-- Requires the vault secret portal_cron_secret; see docs/OPS-AMAZON-API.md.
-- =====================================================================
-- Hourly Amazon sync scheduled from Postgres (Vercel Hobby only allows daily crons).
-- Applied to the live project on 2026-10-02 as migrations `enable_pg_cron_pg_net`
-- and `portal_hourly_cron_jobs`.
--
-- Prerequisite (run once, value must equal CRON_SECRET in Vercel):
--   select vault.create_secret('<secret>', 'portal_cron_secret', 'Bearer token for portal.aayat.co cron routes');

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create schema if not exists ops;
revoke all on schema ops from public, anon, authenticated;

create or replace function ops.portal_cron_call(p_path text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
  v_request_id bigint;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'portal_cron_secret'
  limit 1;
  if v_secret is null then
    raise exception 'portal_cron_secret missing from vault';
  end if;

  select net.http_get(
    url := 'https://portal.aayat.co' || p_path,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'User-Agent', 'supabase-pg-cron'
    ),
    timeout_milliseconds := 290000
  ) into v_request_id;
  return v_request_id;
end;
$$;

revoke all on function ops.portal_cron_call(text) from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname in ('portal_amazon_hourly', 'portal_ads_collect', 'portal_keepalive');
-- SP-API finance/orders + Ads start + dashboard snapshots, every hour at :15 UTC
select cron.schedule('portal_amazon_hourly', '15 * * * *', $$select ops.portal_cron_call('/api/amazon/hourly')$$);
-- Drain finished Ads report jobs, every hour at :35 UTC
select cron.schedule('portal_ads_collect', '35 * * * *', $$select ops.portal_cron_call('/api/amazon/ads/collect')$$);
-- Weekly token keepalive, Monday 03:00 UTC
select cron.schedule('portal_keepalive', '0 3 * * 1', $$select ops.portal_cron_call('/api/amazon/keepalive')$$);
