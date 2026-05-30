-- P0.2 — adds a salted duplicate-detection fingerprint column.
--
-- Old `code_fingerprint` = SHA-256(brand|code) — unsalted, lets anyone with DB
-- access build a rainbow table of likely card codes and identify which user
-- holds a known card. New `code_fingerprint_v2` = SHA-256(user_uuid|brand|code)
-- so the same card under two different users hashes differently.
--
-- Both columns coexist. Old rows still match via v1 until they migrate
-- naturally (next save by the same user re-computes both fingerprints, and the
-- v1→v2 ciphertext upgrade in P0.1 also populates v2 fingerprints).

BEGIN;

ALTER TABLE gift_cards_vault
  ADD COLUMN IF NOT EXISTS code_fingerprint_v2 text;

CREATE INDEX IF NOT EXISTS gift_cards_vault_code_fingerprint_v2_idx
  ON gift_cards_vault (code_fingerprint_v2)
  WHERE code_fingerprint_v2 IS NOT NULL;

COMMIT;
