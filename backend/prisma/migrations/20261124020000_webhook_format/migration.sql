-- Which message an outbound webhook sends: "auto" decides from the address (Slack, Discord and Teams addresses get a chat message, any other
-- address gets RemoteIQ's signed JSON), or one of remoteiq, slack, discord, teams to say so.
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'auto';
