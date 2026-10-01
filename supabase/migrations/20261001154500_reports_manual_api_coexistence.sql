-- Amazon manual uploads and SP-API syncs for the same account, platform and
-- period are separate reports. The unique key includes `source`, so a manual
-- save cannot replace an API row (and an API sync cannot replace a manual row).
--
-- Existing rows are left in place. `source` defaults to 'manual' only when the
-- column is missing, which matches every report created before the API sync.
--
-- Safe to re-run. On the production database this is a no-op: the constraint
-- reports_account_period_platform_source_key already exists.

alter table public.reports
  add column if not exists source text not null default 'manual';

create index if not exists idx_reports_account_source
  on public.reports(account_id, source);

do $$
declare
  rel_oid oid;
  con record;
  cols text[];
  has_source_unique boolean := false;
begin
  select c.oid into rel_oid
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'reports';

  if rel_oid is null then
    return;
  end if;

  for con in
    select c.oid, c.conname, c.conkey
    from pg_constraint c
    where c.conrelid = rel_oid and c.contype = 'u'
  loop
    select array_agg(a.attname::text order by a.attname)
      into cols
    from unnest(con.conkey) as u(attnum)
    join pg_attribute a on a.attrelid = rel_oid and a.attnum = u.attnum;

    if cols = array['account_id', 'period_end', 'period_start', 'platform', 'source']::text[] then
      has_source_unique := true;
    elsif cols = array['account_id', 'period_end', 'period_start', 'platform']::text[] then
      -- Pre-source key. Dropping it does not delete rows; it only stops a
      -- manual upsert from colliding with an API report for the same dates.
      execute format('alter table public.reports drop constraint %I', con.conname);
    end if;
  end loop;

  if not has_source_unique then
    alter table public.reports
      add constraint reports_account_period_platform_source_key
      unique (account_id, period_start, period_end, platform, source);
  end if;
end $$;
