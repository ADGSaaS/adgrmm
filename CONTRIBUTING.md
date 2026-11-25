# Contributing to RemoteIQ

Thanks for wanting to help. This is an early-stage project, so please open an issue to talk about a larger change before you spend time on it.

## Before you start

- Read the [README](README.md) for how the parts fit together and how to run them for development.
- [`docs/roadmap/ROADMAP.md`](docs/roadmap/ROADMAP.md) lists what is built, what is untested and what is planned. A change that finishes something on it is the easiest to accept.
- Security problems are not reported in public issues. See [SECURITY.md](SECURITY.md).

## Making a change

1. Fork the repository and make a branch.
2. Keep each pull request to one purpose, with a short description of what changes and why.
3. Add or update a test when you change behaviour. The backend tests are plain Node scripts in `backend/test` (see the README, "Testing and CI").
4. Check that the backend compiles (`cd backend && npx tsc --noEmit -p tsconfig.json`) and the web app builds (`cd frontend && npx next build`).
5. Do not commit secrets, `.env` files, customer data, or uploaded files.

## Licence of your contribution

RemoteIQ is released under the [GNU Affero General Public License v3.0](LICENSE). By sending a contribution you agree that it is licensed under the same licence. Please add a sign-off line to your commit messages to say you have the right to submit it:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you.
