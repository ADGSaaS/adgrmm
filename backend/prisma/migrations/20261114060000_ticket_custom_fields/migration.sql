-- Custom fields for tickets: the same definitions table as customers, with an entity of 'ticket', and the values kept on the ticket.
ALTER TABLE custom_field_defs DROP CONSTRAINT IF EXISTS custom_field_defs_entity_check;
ALTER TABLE custom_field_defs ADD CONSTRAINT custom_field_defs_entity_check CHECK (entity IN ('customer', 'ticket'));

-- Whether the customer sees the field (and its value) on their ticket in the client portal.
ALTER TABLE custom_field_defs ADD COLUMN IF NOT EXISTS visible_to_customer boolean NOT NULL DEFAULT false;

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
