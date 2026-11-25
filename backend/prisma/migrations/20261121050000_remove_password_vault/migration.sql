-- The built-in password vault is gone: customer passwords belong in the owner's separate software (Killian), not in RemoteIQ.
-- (The device secrets feature, BitLocker recovery keys and local administrator passwords, is a different thing and stays.)
-- Links that pointed at a stored password are only pointers, so they are removed. The table itself is dropped ONLY when it is empty: if
-- it still holds stored passwords it is kept exactly as it is (nothing reads it any more) and a notice says so, so that nothing is lost
-- before a person has moved them.
DELETE FROM entity_links WHERE a_type = 'vault' OR b_type = 'vault';
DELETE FROM role_permissions WHERE permission_key IN ('vault.read', 'vault.reveal', 'vault.write');
DELETE FROM permissions WHERE permission_key IN ('vault.read', 'vault.reveal', 'vault.write');
DO $$
BEGIN
  IF to_regclass('public.vault_items') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.vault_items) THEN
      DROP TABLE public.vault_items;
      RAISE NOTICE 'The empty vault_items table was removed.';
    ELSE
      RAISE NOTICE 'vault_items still holds stored passwords, so it was kept. Nothing reads it any more.';
    END IF;
  END IF;
END $$;
