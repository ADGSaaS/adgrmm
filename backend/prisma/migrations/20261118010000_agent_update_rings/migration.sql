-- Staged rollout of agent updates (roadmap 10.10).
--
-- A device belongs to one of two update rings: 'pilot' (the test group, offered a candidate build first) or 'stable' (everyone
-- else). devices.update_ring NULL means "follow the customer"; clients.default_update_ring is what such devices follow
-- (default 'stable'), so every existing device stays on 'stable' and nothing changes until somebody sets a ring.
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS update_ring text;
ALTER TABLE public.devices DROP CONSTRAINT IF EXISTS devices_update_ring_check;
ALTER TABLE public.devices ADD CONSTRAINT devices_update_ring_check CHECK (update_ring IS NULL OR update_ring IN ('pilot', 'stable'));

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS default_update_ring text NOT NULL DEFAULT 'stable';
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_default_update_ring_check;
ALTER TABLE public.clients ADD CONSTRAINT clients_default_update_ring_check CHECK (default_update_ring IN ('pilot', 'stable'));

CREATE INDEX IF NOT EXISTS devices_update_ring_idx ON public.devices (update_ring) WHERE update_ring IS NOT NULL;

-- When an agent's reported version last changed, so the release health gate can tell "updated and still checking in" from
-- "updated and then went quiet". Kept by a trigger so every way the version is written is covered. NULL = unknown (before this).
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS version_changed_at timestamptz;

CREATE OR REPLACE FUNCTION public.agents_track_version_change() RETURNS trigger AS $$
BEGIN
  -- (an update that sets version_changed_at itself keeps what it set)
  IF NEW.version IS DISTINCT FROM OLD.version AND NEW.version_changed_at IS NOT DISTINCT FROM OLD.version_changed_at THEN
    NEW.version_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_track_version_change ON public.agents;
CREATE TRIGGER agents_track_version_change
  BEFORE UPDATE OF version ON public.agents
  FOR EACH ROW EXECUTE PROCEDURE public.agents_track_version_change();

-- Every ring change, promotion and withdrawal of a candidate build: who, what, which versions, how many devices were in each ring.
CREATE TABLE IF NOT EXISTS public.agent_releases_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  at              timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid,
  actor_email     text,
  action          text NOT NULL CHECK (action IN ('ring-device', 'ring-customer', 'ring-bulk', 'promote', 'withdraw')),
  os              text,
  version         text,
  previous_version text,
  ring_counts     jsonb NOT NULL DEFAULT '{}'::jsonb,
  forced          boolean NOT NULL DEFAULT false,
  reason          text,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS agent_releases_log_at_idx ON public.agent_releases_log (at DESC);
