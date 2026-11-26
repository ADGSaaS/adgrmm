// backend/src/demo/demo.people.ts
//
// The fictional people and companies of the demo: six customers with their contacts and sites, and four technicians.
// Every address is on example.com or .invalid, every phone number is a 555-01xx number, and every street and town is made up.

export type DemoContact = { name: string; title: string; role: "primary" | "billing" | "technical" | "owner" | "other"; primary?: boolean; mobile?: boolean };
export type DemoCustomer = {
    name: string; legal: string; industry: string; domain: string; phone: string; employees: number; sinceYearsAgo: number;
    zone: string; terms: string; note: string; tags: string[];
    address: { line1: string; city: string; region: string; postalCode: string };
    contacts: DemoContact[];
    sites: string[];
};

export const CUSTOMERS: DemoCustomer[] = [
    {
        name: "Harbor Dental", legal: "Harbor Dental Group, LLC", industry: "Healthcare: dental practice", domain: "harbor-dental.example.com", phone: "555-0142", employees: 14, sinceYearsAgo: 4.3,
        zone: "America/Los_Angeles", terms: "Net 30", note: "Two-chair practice. Imaging software is vendor-managed: ask before touching the X-ray PC.", tags: ["healthcare", "managed"],
        address: { line1: "210 Example Harbor Way", city: "Port Alder", region: "WA", postalCode: "99001" },
        contacts: [
            { name: "Maria Santos", title: "Office Manager", role: "primary", primary: true },
            { name: "Dr. Priya Patel", title: "Owner and Dentist", role: "owner", mobile: true },
            { name: "Tom Reyes", title: "Front Desk Coordinator", role: "other" },
            { name: "Elena Fischer", title: "Bookkeeper", role: "billing" },
        ],
        sites: ["Main clinic", "Front desk"],
    },
    {
        name: "Summit Law", legal: "Summit & Whitaker LLP", industry: "Legal services", domain: "summit-law.example.com", phone: "555-0157", employees: 22, sinceYearsAgo: 3.1,
        zone: "America/Chicago", terms: "Net 15", note: "Client files are confidential. Never open documents on the file server without a ticket reference.", tags: ["legal", "managed", "vip"],
        address: { line1: "88 Example Court Plaza, Suite 400", city: "Fairmont Heights", region: "IL", postalCode: "99002" },
        contacts: [
            { name: "Jonathan Summit", title: "Managing Partner", role: "owner", mobile: true },
            { name: "Grace Whitaker", title: "Office Administrator", role: "primary", primary: true },
            { name: "Dev Malhotra", title: "Senior Paralegal", role: "technical" },
            { name: "Nora Lindgren", title: "Accounts", role: "billing" },
        ],
        sites: ["Downtown", "Remote staff"],
    },
    {
        name: "Brightwater Accounting Partners", legal: "Brightwater Accounting Partners, PC", industry: "Accounting and tax", domain: "brightwater-cpa.example.com", phone: "555-0163", employees: 17, sinceYearsAgo: 2.4,
        zone: "America/New_York", terms: "Net 30", note: "Busy season runs January to April: avoid maintenance on weekdays.", tags: ["accounting", "managed"],
        address: { line1: "17 Example Ledger Lane", city: "Brightwater", region: "NY", postalCode: "99003" },
        contacts: [
            { name: "Priti Shah", title: "Office Manager", role: "primary", primary: true },
            { name: "Elise Whitfield", title: "Managing Partner", role: "owner", mobile: true },
            { name: "Daniel Pereira", title: "Senior Accountant", role: "other" },
            { name: "Chloe Nakamura", title: "Staff Accountant", role: "other" },
            { name: "Luke Harrow", title: "Associate (branch office)", role: "other" },
        ],
        sites: ["Head office", "Branch office"],
    },
    {
        name: "Larkspur Outfitters", legal: "Larkspur Outfitters Inc.", industry: "Retail: outdoor goods", domain: "larkspur-outfitters.example.com", phone: "555-0178", employees: 31, sinceYearsAgo: 1.8,
        zone: "America/Denver", terms: "Net 30", note: "Two shops and a warehouse. Point-of-sale terminals must stay online during opening hours (9 to 8).", tags: ["retail", "pos"],
        address: { line1: "402 Example Trailhead Road", city: "Larkspur Falls", region: "CO", postalCode: "99004" },
        contacts: [
            { name: "Dana Ortiz", title: "Store 1 Manager", role: "primary", primary: true },
            { name: "Marcus Bell", title: "Owner", role: "owner", mobile: true },
            { name: "Hector Lim", title: "Store 2 Manager", role: "other" },
            { name: "Wendy Cho", title: "Accounts Payable", role: "billing" },
        ],
        sites: ["Store 1", "Store 2", "Warehouse"],
    },
    {
        name: "Ironbridge Fabrication", legal: "Ironbridge Fabrication Co.", industry: "Manufacturing: metal fabrication", domain: "ironbridge-fab.example.com", phone: "555-0184", employees: 64, sinceYearsAgo: 5.2,
        zone: "America/Detroit", terms: "Net 45", note: "Plant-floor PCs run legacy machine software: do not upgrade Windows without a plan.", tags: ["manufacturing", "managed", "servers"],
        address: { line1: "1 Example Foundry Drive", city: "Ironbridge", region: "MI", postalCode: "99005" },
        contacts: [
            { name: "Dwayne Hale", title: "Operations Manager", role: "primary", primary: true },
            { name: "Tomasz Kowalski", title: "Engineering Lead", role: "technical" },
            { name: "Rachel Baptiste", title: "CAD Designer", role: "other" },
            { name: "Ingrid Sol", title: "Finance Controller", role: "billing" },
            { name: "Bill Mercer", title: "Plant Supervisor", role: "other" },
        ],
        sites: ["Office", "Plant"],
    },
    {
        name: "Maple Grove Academy", legal: "Maple Grove Academy Foundation", industry: "Education: independent school", domain: "maplegrove-academy.example.com", phone: "555-0191", employees: 48, sinceYearsAgo: 2.9,
        zone: "America/New_York", terms: "Net 30", note: "Term starts early September: new student accounts and lab images must be ready the week before.", tags: ["education", "managed"],
        address: { line1: "55 Example Meadow Road", city: "Maple Grove", region: "VT", postalCode: "99006" },
        contacts: [
            { name: "Sandra Okoye", title: "Registrar", role: "primary", primary: true },
            { name: "Dr. Helen Ashford", title: "Head of School", role: "owner", mobile: true },
            { name: "Miguel Rosales", title: "Science Teacher", role: "other" },
            { name: "Paul Giordano", title: "Facilities Manager", role: "technical" },
        ],
        sites: ["Main building", "Science wing"],
    },
];

export const TECHS = [
    { first: "Alex", last: "Rivera", email: "alex.rivera@demo.invalid" },
    { first: "Sam", last: "Okafor", email: "sam.okafor@demo.invalid" },
    { first: "Riley", last: "Chen", email: "riley.chen@demo.invalid" },
    { first: "Jordan", last: "Blake", email: "jordan.blake@demo.invalid" },
];

export const emailOf = (name: string, domain: string) =>
    `${name.replace(/^Dr\.\s+/, "").toLowerCase().replace(/[^a-z ]/g, "").trim().replace(/\s+/g, ".")}@${domain}`;
