-- Track origin of each gift card row so the UI can show a source badge.
-- Allowed values: 'manual', 'ai_text', 'image', 'gmail'.
alter table if exists public.gift_cards_vault
  add column if not exists source text not null default 'manual';

create index if not exists gift_cards_vault_source_idx
  on public.gift_cards_vault (user_uuid, source);
