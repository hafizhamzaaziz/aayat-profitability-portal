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
