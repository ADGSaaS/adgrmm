import { Injectable } from "@nestjs/common";
import {
    ENVIRONMENT_DEFINITIONS,
    type EnvironmentDefinition,
} from "./environment.registry";

export type EnvironmentItemDto = EnvironmentDefinition & {
    configured: boolean;
    value: string | null;
    valueRedacted: boolean;
    runtimeSource: "process.env";
    writeEnabled: false;
};

@Injectable()
export class EnvironmentService {
    list() {
        const items: EnvironmentItemDto[] = ENVIRONMENT_DEFINITIONS.map(
            (definition) => {
                const raw = process.env[definition.key];
                const configured =
                    typeof raw === "string" && raw.length > 0;

                const mayExpose =
                    configured && definition.exposeValue;

                return {
                    ...definition,
                    configured,

                    // Never return a secret or host-trust value.
                    value: mayExpose ? raw! : null,

                    valueRedacted:
                        configured && !definition.exposeValue,

                    // Node cannot reliably determine whether a value came
                    // from systemd, dotenv, or the inherited environment.
                    // Report only the truthful runtime source.
                    runtimeSource: "process.env",

                    // Phase 7A.1 is intentionally read-only.
                    writeEnabled: false,
                };
            },
        );

        return {
            version: 1,
            mode: "read-only" as const,
            writesEnabled: false,
            generatedAt: new Date().toISOString(),
            count: items.length,
            items,
        };
    }
}
