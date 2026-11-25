// backend/src/flags/flags.catalog.ts
//
// Every feature flag that exists. A flag is only listed here when code really checks it, so the Feature Flags
// screen never shows a switch that does nothing. Organizations store only what they changed; anything not
// changed takes the default below, which is how the product behaved before the flag existed.

export type FlagDefinition = {
    key: string;
    label: string;
    description: string;
    /** What the product did before this flag existed. */
    defaultEnabled: boolean;
    /** Where the flag is checked, in plain words, so an administrator knows what turning it off changes. */
    effect: string;
};

export const FLAG_CATALOG: readonly FlagDefinition[] = [
    {
        key: "demo_data",
        label: "Demo data",
        description: "Lets an administrator fill the system with sample customers and endpoints for demonstrations.",
        defaultEnabled: true,
        effect: "When off, demo data cannot be turned on and the Demo data screen is hidden. Demo data that already exists can still be removed through the API.",
    },
    {
        key: "freshdesk_import",
        label: "Import from Freshdesk",
        description: "The one-off import of tickets, contacts and companies from a Freshdesk account.",
        defaultEnabled: true,
        effect: "When off, an import cannot be previewed or started and the Import from Freshdesk screen is hidden. Earlier import results stay.",
    },
];

export const FLAG_KEYS: ReadonlySet<string> = new Set(FLAG_CATALOG.map((f) => f.key));
