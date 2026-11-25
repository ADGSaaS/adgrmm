-- The built-in IT Docs documents (with templates and version history) are gone: documentation belongs in the owner's separate software
-- (Killian), not in RemoteIQ. Links that pointed at a document are only pointers, so they are removed, and so are the two rights.
-- The tables are dropped ONLY when no document was ever written: if there are documents they are kept exactly as they are (nothing reads
-- them any more) and a notice says so, so that nothing is lost before a person has moved them.
DELETE FROM entity_links WHERE a_type = 'document' OR b_type = 'document';
DELETE FROM role_permissions WHERE permission_key IN ('docs.read', 'docs.write');
DELETE FROM permissions WHERE permission_key IN ('docs.read', 'docs.write');
DO $$
BEGIN
  IF to_regclass('public.documents') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.documents) THEN
      DROP TABLE IF EXISTS public.document_versions;
      DROP TABLE public.documents;
      RAISE NOTICE 'The empty documents tables were removed.';
    ELSE
      RAISE NOTICE 'documents still holds documents, so the tables were kept. Nothing reads them any more.';
    END IF;
  END IF;
END $$;
