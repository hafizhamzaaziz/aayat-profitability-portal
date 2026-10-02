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
