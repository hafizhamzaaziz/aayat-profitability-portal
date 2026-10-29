alter table public.inventory_levels
  add column if not exists updated_by uuid references public.users(id) on delete set null;
