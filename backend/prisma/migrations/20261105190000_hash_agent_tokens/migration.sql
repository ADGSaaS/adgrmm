-- Agent tokens become SHA-256 hashes at rest, so reading the database no longer yields
-- working agent credentials. Agents keep the same token; the backend hashes what they present.
UPDATE public.agents
   SET agent_token = encode(sha256(convert_to(agent_token, 'UTF8')), 'hex')
 WHERE agent_token IS NOT NULL AND agent_token <> '';

UPDATE public.agents
   SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex')
 WHERE token IS NOT NULL AND token <> '';
