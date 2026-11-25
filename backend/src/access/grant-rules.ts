// Who is asking, and what they are allowed to hand out. Used by users, roles and groups so that
// nobody can give another person (or themselves) more than they hold.
import { ForbiddenException } from "@nestjs/common";
import { ALL_PERMISSIONS, PERMISSION_DEFINITIONS, isOwnerRoleName } from "../auth/policy";

export type Actor = {
    id: string | null;
    /** Everything the person may do, lowercase. */
    perms: Set<string>;
    /** Owners may do anything, and only owners may change owners. */
    owner: boolean;
};

/** The person behind a request. A request with no user at all is the break-glass admin key, which is owner-level. */
export function actorOf(req: any): Actor {
    const user = req?.user;
    if (!user) return { id: null, perms: new Set(ALL_PERMISSIONS), owner: true };
    const owner = [...(Array.isArray(user.roles) ? user.roles : []), user.role].some(isOwnerRoleName);
    const fromGuard: Set<string> | undefined = req?.effectivePermissions;
    const perms = new Set<string>(fromGuard ? [...fromGuard] : (Array.isArray(user.permissions) ? user.permissions : []).map((p: any) => String(p).toLowerCase()));
    if (owner) ALL_PERMISSIONS.forEach((p) => perms.add(p));
    return { id: user.id ? String(user.id) : null, perms, owner };
}

const LABEL = new Map(PERMISSION_DEFINITIONS.map((d) => [d.key as string, d.label]));

/** The permissions in `wanted` that the actor does not hold, by their readable name. */
export function missingPerms(actor: Actor, wanted: Iterable<string>): string[] {
    if (actor.owner) return [];
    const out: string[] = [];
    for (const raw of wanted) {
        const key = String(raw).toLowerCase();
        if (!actor.perms.has(key)) out.push(LABEL.get(key) ?? key);
    }
    return out;
}

/** Throws when the actor would be handing out something they do not have themselves. */
export function assertCanGrant(actor: Actor, wanted: Iterable<string>, what = "permissions") {
    const missing = missingPerms(actor, wanted);
    if (missing.length) {
        const shown = missing.slice(0, 4).join(", ") + (missing.length > 4 ? ` and ${missing.length - 4} more` : "");
        throw new ForbiddenException(`You cannot give ${what} that you do not have yourself (${shown}).`);
    }
}
