-- Internal knowledge base: articles technicians write and search, with history, feedback, ticket links and an optional
-- "visible to customers in the portal" flag. This is the help-desk knowledge base only, not customer documentation.
CREATE TABLE IF NOT EXISTS kb_categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kb_categories_name_uq ON kb_categories (organization_id, lower(name));

CREATE TABLE IF NOT EXISTS kb_articles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category_id      uuid REFERENCES kb_categories(id) ON DELETE SET NULL,
  title            text NOT NULL,
  body             text NOT NULL DEFAULT '',
  tags             text[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  customer_visible boolean NOT NULL DEFAULT false,
  author_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  version          integer NOT NULL DEFAULT 1,
  view_count       integer NOT NULL DEFAULT 0,
  helpful_count    integer NOT NULL DEFAULT 0,
  unhelpful_count  integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz
);
CREATE INDEX IF NOT EXISTS kb_articles_org_idx ON kb_articles (organization_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS kb_articles_category_idx ON kb_articles (category_id);
-- array_to_string is only STABLE, so the index needs this IMMUTABLE wrapper.
CREATE OR REPLACE FUNCTION kb_tags_text(text[]) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT array_to_string($1, ' ') $$;
CREATE INDEX IF NOT EXISTS kb_articles_fts_idx ON kb_articles USING gin (
  (setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
   setweight(to_tsvector('english', kb_tags_text(tags)), 'B') ||
   setweight(to_tsvector('english', coalesce(body, '')), 'C'))
);

CREATE TABLE IF NOT EXISTS kb_article_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  version    integer NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  tags       text[] NOT NULL DEFAULT '{}',
  saved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  saved_at   timestamptz NOT NULL DEFAULT now(),
  note       text,
  UNIQUE (article_id, version)
);

-- One vote per person per article; voting again changes it. voter_key is "u:<user id>" or "p:<portal account id>".
CREATE TABLE IF NOT EXISTS kb_feedback (
  article_id uuid NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  voter_key  text NOT NULL,
  helpful    boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, voter_key)
);

CREATE TABLE IF NOT EXISTS kb_ticket_links (
  ticket_id  uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  linked_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, article_id)
);
CREATE INDEX IF NOT EXISTS kb_ticket_links_article_idx ON kb_ticket_links (article_id);

INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES
  ('kb.read', 'Read the knowledge base', 'kb', 'Knowledge base'),
  ('kb.write', 'Write and manage knowledge base articles', 'kb', 'Knowledge base')
ON CONFLICT (permission_key) DO NOTHING;

-- Technicians (operator, viewer) read; managers (admin) write. Owner holds everything by rule.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'kb.read' FROM roles r WHERE lower(r.name) IN ('admin', 'operator', 'viewer')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'kb.write' FROM roles r WHERE lower(r.name) IN ('admin')
ON CONFLICT DO NOTHING;

-- The portal gets a "knowledge" area. It shows only articles marked visible to customers, so there is nothing to see
-- until someone marks one; turning it on for existing portals is harmless.
ALTER TABLE portal_settings ALTER COLUMN modules SET DEFAULT ARRAY['dashboard', 'tickets', 'devices', 'invoices', 'reports', 'knowledge']::text[];
UPDATE portal_settings SET modules = array_append(modules, 'knowledge') WHERE NOT ('knowledge' = ANY (modules));
