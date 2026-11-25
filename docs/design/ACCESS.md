# Users, roles and groups: audit and design

Status: findings 1-7 fixed and groups built (backend, tests in test/access-http.e2e.cjs, Administration > Groups,
group chips and an effective-access panel on each user). Decisions taken with the owner: group permissions add to
the role; group scope can name customers, sites and tags; built-in roles are made real, with today's defaults copied
in once so nobody's access changed.

Not done yet: invitation links by email (finding 8), several roles per person in the UI (10), deactivate instead of
delete beyond the foreign-key guard (11), reports for people whose access is only sites or tags (they see nothing
there, the safe side), and hiding a customer's other sites from a person limited to one of its sites.

## Audit findings (backend)

Serious
1. **Built-in roles cannot be tightened.** `PermissionsGuard` always merges the hard-coded
   defaults for a role *name* (`permsForRoles` in `auth/policy.ts`) with what is stored in
   `role_permissions`. Unticking a permission on Operator or Viewer in the Roles screen does
   nothing. A custom role named "operator" also picks up the Operator defaults.
2. **Privilege escalation.** Anyone with `users.write` plus `roles.write` can give themselves
   (or anyone) the Owner role, or add every permission to their own role. Nothing checks that the
   person granting holds what they grant.
3. **No lock-out protection.** An admin can delete, suspend or demote themselves or the last
   Owner. `remove`, `setSuspended`, `updateRole`, `reset2fa` take any id with no check of the
   organisation.
4. **`inviteOne` overwrites real accounts.** Inviting an email that already exists sets that
   active user back to "invited" and replaces their roles. `createOne` does the same and also
   replaces the password.
5. **Password reset does not end sessions.** After an admin sets a password, the old sessions and
   tokens stay valid. (Suspending is fine: status is checked on every request.)

Medium
6. Changing a user's email has no duplicate check, so a clash is a 500.
7. Bulk invite is not atomic and stops half way on the first error.
8. No invitation flow: invited users get no email or one-time link to set a password.
9. Role changes do not say who is affected, and a role cannot be copied.
10. A user holds one role in the UI although the database allows several.
11. Deleting a user hard-deletes (tickets, jobs and audit rows keep dangling ids). Should be
    "deactivate", with delete only for never-active accounts.
12. Customer limits (`user_client_access`) are a flat list per user: no sites, no tags, no
    groups, no "everyone in this team".

Good already: deny-by-default guard, audit rows for every user and role change, session revoke
on suspend, role name uniqueness, protected Owner/Admin names, bcrypt 12.

## Design: groups

A group is a named team of users with an optional role-like permission list and a scope.

- `user_groups`: id, organization_id, name, description, created_at, updated_at.
- `user_group_members`: group_id, user_id.
- `user_group_permissions`: group_id, permission_key.
- `user_group_scope`: group_id, kind (customer | site | tag), target_id.

Effective access for a user:
- permissions = role permissions + permissions of every group the user is in (additive).
- scope = the user's own customer limits + scopes of their groups. If the user and all of their
  groups have no scope, the user sees everything (unchanged behaviour).
- the existing `ClientAccessService` is the single place that answers "which customers", so
  it changes once and every screen that already uses it follows.

UI: Administration → Groups (list, members, permissions, scope, "what can this group see"),
a Groups chip list on each user, and an "Effective access" panel on the user showing every
permission and customer with the role or group it came from.

## Plan
1. Fix findings 1-7 (with tests), including seeding `role_permissions` for built-in roles so
   nothing changes for anyone today.
2. Groups backend, tests, and wiring into the permission guard and `ClientAccessService`.
3. UI: Groups tab, user group chips, effective-access panel, role copy, invitation links,
   safer delete.
