-- Add missing indexes for /show, /search, and /show_all performance
-- Run once in Supabase SQL editor

CREATE INDEX IF NOT EXISTS gift_cards_vault_telegram_id_redeemed_idx
  ON gift_cards_vault (telegram_id, is_redeemed);

CREATE INDEX IF NOT EXISTS gift_cards_vault_brand_idx
  ON gift_cards_vault (brand);
