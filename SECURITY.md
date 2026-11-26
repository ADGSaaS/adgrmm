# Security policy

ADG RMM manages computers and customer data, so security problems matter. Thank you for reporting them responsibly.

## Supported versions

Security fixes go into the newest release. Please check that a problem still exists in the newest release before you report it.

## How to report a problem

**Do not open a public issue for a security problem.**

Use GitHub's private reporting: open the **Security** tab of this repository, choose **Report a vulnerability**, and describe what you found. Only the maintainers can see the report.

Please include:

- what the problem is and which part is affected (backend, web app, Windows agent, Linux agent, installer);
- the version, and how you installed it (Docker or native);
- the steps to reproduce it, or a short proof of concept;
- what an attacker could do with it.

Please do not test against systems you do not own, access data that is not yours, or disturb other people's service. A test installation of your own is the right place.

## What happens next

We will acknowledge your report as soon as we can, look into it, and tell you what we decide. When a fix is released we will say so in the release notes, and we are glad to credit you if you want that.

## Running ADG RMM safely

If you host ADG RMM yourself:

- Use HTTPS only. The sign-in cookie is marked secure.
- Back up `/opt/adgrmm/secrets/` (the data key and the job signing key) somewhere that does not also hold your database backups.
- Set `ADMIN_API_KEY` only if you need it, and make it long and random (at least 24 characters). The server refuses weak values.
- Set `FRONTEND_ORIGINS` to your real console address. In production the server refuses to start without it.
- Keep ADG RMM up to date: `sudo bash /opt/adgrmm/install.sh upgrade`.
- Treat a site install key like a password. Anyone with it can enroll devices into that site. Revoke keys you no longer use under Administration, Install keys.
- Give technicians only the customers they need (Administration, Customer access). A technician limited to some customers cannot reach the others.
