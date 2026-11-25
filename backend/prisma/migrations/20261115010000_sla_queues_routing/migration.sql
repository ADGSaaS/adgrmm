-- Service desk: SLA policies and business-hours calendars, a timer row per ticket, queues, routing rules and in-app notices.

-- Working-hours calendars. A policy with no calendar runs around the clock.
CREATE TABLE IF NOT EXISTS sla_calendars (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'UTC',
  days            integer[] NOT NULL DEFAULT '{1,2,3,4,5}',
  start_time      text NOT NULL DEFAULT '09:00',
  end_time        text NOT NULL DEFAULT '17:00',
  -- [{ "date": "2026-12-25", "name": "Christmas Day" }]
  holidays        jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sla_calendars_name_uq ON sla_calendars (organization_id, lower(name));

CREATE TABLE IF NOT EXISTS sla_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  calendar_id     uuid REFERENCES sla_calendars(id) ON DELETE RESTRICT,
  is_default      boolean NOT NULL DEFAULT false,
  enabled         boolean NOT NULL DEFAULT true,
  -- { "low": { "response": 480, "resolution": 4320 }, "medium": {...}, "high": {...}, "urgent": {...} } in minutes; a missing number means no target
  targets         jsonb NOT NULL DEFAULT '{}',
  -- Ticket statuses that stop the clocks (waiting on the customer).
  pause_statuses  text[] NOT NULL DEFAULT '{pending}',
  warn_percent    integer NOT NULL DEFAULT 80 CHECK (warn_percent BETWEEN 1 AND 99),
  -- { "warning": { "users": [], "groups": [], "email": false }, "breach": { "users": [], "groups": [], "email": false, "raisePriority": false, "reassignUserId": null } }
  escalation      jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sla_policies_name_uq ON sla_policies (organization_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS sla_policies_one_default ON sla_policies (organization_id) WHERE is_default;

-- A customer's own policy, in place of the default one.
CREATE TABLE IF NOT EXISTS sla_client_policies (
  client_id  uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  policy_id  uuid NOT NULL REFERENCES sla_policies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Queues: where tickets wait for someone, and who gets them.
CREATE TABLE IF NOT EXISTS ticket_queues (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                     text NOT NULL,
  description              text,
  enabled                  boolean NOT NULL DEFAULT true,
  -- none: tickets wait unassigned; user: one default person; round_robin: the pool takes turns
  assignment               text NOT NULL DEFAULT 'none' CHECK (assignment IN ('none', 'user', 'round_robin')),
  default_assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  pool_user_ids            uuid[] NOT NULL DEFAULT '{}',
  pool_group_id            uuid REFERENCES user_groups(id) ON DELETE SET NULL,
  last_assigned_user_id    uuid,
  default_sla_policy_id    uuid REFERENCES sla_policies(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_queues_name_uq ON ticket_queues (organization_id, lower(name));

CREATE TABLE IF NOT EXISTS ticket_routing_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  position        integer NOT NULL DEFAULT 0,
  -- all: every condition must match; any: one is enough
  match           text NOT NULL DEFAULT 'all' CHECK (match IN ('all', 'any')),
  -- [{ "field": "subject_contains", "value": "printer" }]
  conditions      jsonb NOT NULL DEFAULT '[]',
  -- { "queueId": null, "assignee": "none" | "round_robin" | "<user id>", "priority": null }
  actions         jsonb NOT NULL DEFAULT '{}',
  stop_on_match   boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_routing_rules_order_idx ON ticket_routing_rules (organization_id, position);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS queue_id uuid REFERENCES ticket_queues(id) ON DELETE SET NULL;
-- Where the ticket came from: ui, email, portal, alert, api.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS created_via text;
CREATE INDEX IF NOT EXISTS tickets_queue_idx ON tickets (queue_id);
CREATE INDEX IF NOT EXISTS tickets_assignee_idx ON tickets (assignee_user_id);

-- The two clocks of a ticket. A clock has a target, the working time already used, and runs from running_since;
-- it is not running (running_since is null) while paused, and it is done once the response or resolution happened.
CREATE TABLE IF NOT EXISTS ticket_sla (
  ticket_id                  uuid PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  policy_id                  uuid REFERENCES sla_policies(id) ON DELETE SET NULL,
  policy_name                text NOT NULL,
  priority                   text NOT NULL,
  status                     text NOT NULL,
  paused                     boolean NOT NULL DEFAULT false,
  warn_percent               integer NOT NULL DEFAULT 80,
  response_target_min        integer,
  response_used_ms           bigint NOT NULL DEFAULT 0,
  response_running_since     timestamptz,
  response_due_at            timestamptz,
  response_warn_at           timestamptz,
  response_done_at           timestamptz,
  response_met               boolean,
  response_warned_at         timestamptz,
  response_breached_at       timestamptz,
  resolution_target_min      integer,
  resolution_used_ms         bigint NOT NULL DEFAULT 0,
  resolution_running_since   timestamptz,
  resolution_due_at          timestamptz,
  resolution_warn_at         timestamptz,
  resolution_done_at         timestamptz,
  resolution_met             boolean,
  resolution_warned_at       timestamptz,
  resolution_breached_at     timestamptz,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_sla_resolution_due_idx ON ticket_sla (resolution_due_at);
CREATE INDEX IF NOT EXISTS ticket_sla_response_due_idx ON ticket_sla (response_due_at);

-- In-app notices for a person: shown on the tickets screen until read.
CREATE TABLE IF NOT EXISTS ticket_notices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id       uuid REFERENCES tickets(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz
);
CREATE INDEX IF NOT EXISTS ticket_notices_user_idx ON ticket_notices (user_id, read_at, created_at DESC);
