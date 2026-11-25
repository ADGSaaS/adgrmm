// backend/src/automation/builtin-scripts.ts
//
// The catalog of scripts RemoteIQ ships in the scripts manager (see builtin-scripts.windows.ts and builtin-scripts.linux.ts for the rules every
// one follows). BuiltinScriptsService copies them into the scripts table; this file only holds the data and two small helpers.
import { createHash } from "node:crypto";
import { LINUX_SCRIPTS } from "./builtin-scripts.linux";
import { CROSS_SCRIPTS } from "./builtin-scripts.cross";
import { WINDOWS_SCRIPTS } from "./builtin-scripts.windows";
import { BUILTIN_CATEGORIES, type BuiltinScript } from "./builtin-scripts.types";

export { BUILTIN_CATEGORIES };
export type { BuiltinScript } from "./builtin-scripts.types";

/** Bumped when the catalog changes in a way worth recording; each script also carries a hash of its own text. */
export const BUILTIN_VERSION = 1;

/** The single-system catalogs (Windows and Linux), as they were first shipped. */
export const BUILTIN_SCRIPTS: BuiltinScript[] = [...WINDOWS_SCRIPTS, ...LINUX_SCRIPTS];

/** Everything that is shipped: those, and the scripts made for Windows, Linux and macOS together. */
export const ALL_BUILTIN_SCRIPTS: BuiltinScript[] = [...BUILTIN_SCRIPTS, ...CROSS_SCRIPTS];
export { CROSS_SCRIPTS };

/** A hash of the text a script was shipped with. A stored script whose text still has this hash has not been edited. */
export const textHash = (text: string): string => createHash("sha256").update(Buffer.from(text.replace(/\r\n/g, "\n"), "utf8")).digest("hex");
