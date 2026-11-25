export const BACKUP_TARGET_REGISTRY = {
    users: "public.users",
    roles: "public.roles",
    devices: "public.devices",
    settings: "public.organization_settings",
} as const;

export type SupportedBackupTarget = keyof typeof BACKUP_TARGET_REGISTRY;

export const SUPPORTED_BACKUP_TARGETS =
    Object.keys(BACKUP_TARGET_REGISTRY) as SupportedBackupTarget[];

export function normalizeBackupTargets(value: unknown): string[] {
    if (!Array.isArray(value)) return [];

    const seen = new Set<string>();
    const out: string[] = [];

    for (const raw of value) {
        if (typeof raw !== "string") continue;
        const target = raw.trim();
        if (!target || seen.has(target)) continue;
        seen.add(target);
        out.push(target);
    }

    return out;
}

export function getUnsupportedBackupTargets(targets: readonly string[]): string[] {
    return targets.filter(
        (target) =>
            !Object.prototype.hasOwnProperty.call(BACKUP_TARGET_REGISTRY, target),
    );
}

export function getBackupSourceForTarget(target: string): string | null {
    if (!Object.prototype.hasOwnProperty.call(BACKUP_TARGET_REGISTRY, target)) {
        return null;
    }

    return BACKUP_TARGET_REGISTRY[target as SupportedBackupTarget];
}
