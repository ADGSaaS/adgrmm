-- Where a discovered host's name came from: dns (the DNS server), nbns (a NetBIOS reply from the host), mdns (an mDNS / Bonjour reply from the host).
ALTER TABLE discovered_hosts ADD COLUMN IF NOT EXISTS name_source text;
