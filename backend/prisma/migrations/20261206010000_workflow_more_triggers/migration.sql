-- Workflow rules: two more triggers (a Windows update scan or install fails, a computer goes offline).
ALTER TABLE workflow_rules DROP CONSTRAINT IF EXISTS workflow_rules_trigger_check;
ALTER TABLE workflow_rules ADD CONSTRAINT workflow_rules_trigger_check
  CHECK (trigger IN ('alert.opened', 'device.registered', 'ticket.created', 'patch.failed', 'device.offline'));
