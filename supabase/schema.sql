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
  platform text not null check (platform in ('amazon', 'temu')),
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
  unique(account_id, period_start, period_end, platform)
);
alter table public.reports add column if not exists breakdown jsonb;
alter table public.reports add column if not exists cogs_snapshot jsonb;

-- 4b) parsed row-level report transactions (raw jsonb)
create table if not exists public.report_transactions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  platform text not null check (platform in ('amazon', 'temu')),
  transaction_date date,
  sku text,
  quantity numeric(14,4),
  raw_row jsonb not null,
  created_at timestamptz not null default now()
);
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
  lead_time_days integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (amazon_sku is not null or temu_sku_id is not null)
);
create unique index if not exists sku_mappings_amazon_unique
  on public.sku_mappings(account_id, amazon_sku) where amazon_sku is not null;
create unique index if not exists sku_mappings_temu_unique
  on public.sku_mappings(account_id, temu_sku_id) where temu_sku_id is not null;

-- Optional link from COGS rows to canonical mapping.
alter table public.cogs add column if not exists sku_mapping_id uuid references public.sku_mappings(id) on delete set null;

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
alter table public.cogs enable row level security;
alter table public.cogs_history enable row level security;
alter table public.sku_catalog enable row level security;
alter table public.sku_mappings enable row level security;
alter table public.sku_monthly_sales enable row level security;
alter table public.inventory_defaults enable row level security;
alter table public.inventory_levels enable row level security;
alter table public.pack_profiles enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.shipment_plans enable row level security;
alter table public.shipment_plan_items enable row level security;
alter table public.reports enable row level security;
alter table public.report_transactions enable row level security;
alter table public.expenses enable row level security;
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
drop policy if exists "account_logos_public_read" on storage.objects;
create policy "account_logos_public_read"
on storage.objects
for select
to public
using (bucket_id = 'account_logos');

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
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_report_transactions_changes') THEN
    CREATE TRIGGER audit_report_transactions_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.report_transactions
    FOR EACH ROW EXECUTE FUNCTION public.log_audit_event();
  END IF;
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