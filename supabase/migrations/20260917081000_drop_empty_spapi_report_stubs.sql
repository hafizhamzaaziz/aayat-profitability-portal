-- Empty sp_api report stubs (no transactions) still overlap manual reports,
-- so refresh_inventory_sales_facts prefers them and drops real manual units
-- for that month. Rexo June 2026 was the known case after a short-window
-- ingest replaced the month with 0 rows.
delete from public.reports r
where r.source = 'sp_api'
  and not exists (
    select 1 from public.report_transactions t where t.report_id = r.id
  );
