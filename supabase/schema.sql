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
  updated_at timestamptz not null default now(),
  unique(account_id, sku)
);
alter table public.cogs add column if not exists includes_vat boolean not null default false;
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id, period_start, period_end, platform)
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
  bsr integer,
  review_count integer,
  rating numeric(3,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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
END $$;
-- RLS enable
alter table public.users enable row level security;
alter table public.accounts enable row level security;
alter table public.client_team_members enable row level security;
alter table public.account_team_members enable row level security;
alter table public.cogs enable row level security;
alter table public.reports enable row level security;
alter table public.expenses enable row level security;
alter table public.performance_metrics enable row level security;
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