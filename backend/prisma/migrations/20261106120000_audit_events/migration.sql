-- A record of who did what. Millisecond timestamps, because the paging cursor travels through
-- JavaScript dates: at microsecond precision, paging would skip or repeat rows.
CREATE TABLE public.audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz(3) NOT NULL DEFAULT now(),
    actor_user_id uuid,
    actor_email text,
    action text NOT NULL,
    category text NOT NULL,
    target_type text,
    target_id text,
    target_label text,
    ip text,
    user_agent text,
    outcome text NOT NULL,
    details jsonb
);

CREATE INDEX idx_audit_events_created_at ON public.audit_events (created_at DESC);
CREATE INDEX idx_audit_events_actor ON public.audit_events (actor_user_id);
CREATE INDEX idx_audit_events_target ON public.audit_events (target_type, target_id);
CREATE INDEX idx_audit_events_category ON public.audit_events (category);
