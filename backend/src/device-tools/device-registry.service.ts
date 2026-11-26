// backend/src/device-tools/device-registry.service.ts
//
// The remote registry browser (read-only, phase 1): runs the fixed scripts of device-registry.scripts.ts as signed script jobs
// through the same job flow as the services / processes / event log tools (pending answer when the device is slow).
import { BadRequestException, Injectable } from "@nestjs/common";
import { DeviceToolsService, type Target } from "./device-tools.service";
import { DeviceRegistryWriteService } from "./device-registry-write.service";
import {
    REGISTRY_SCRIPTS, type RegistryKeyResult, type RegistryRootsResult, type RegistrySearchResult, type RegistryView, type SearchIn,
} from "./device-registry.scripts";

@Injectable()
export class DeviceRegistryService {
    constructor(private readonly tools: DeviceToolsService, private readonly writes: DeviceRegistryWriteService) { }

    /** The registry exists on Windows only. */
    requireWindows(t: Target) {
        if (t.family !== "windows") throw new BadRequestException("The registry browser is only available for Windows devices.");
    }

    async key(t: Target, path: string, view: RegistryView): Promise<{ jobId: string; pending: boolean } & Partial<RegistryKeyResult>> {
        const env = { ADG_REG_PATH: path, ADG_REG_VIEW: view };
        const { jobId, answer } = await this.tools.run(t, "registry.key", REGISTRY_SCRIPTS.key, env, this.tools.reader("registry.key", t.family, env));
        return { jobId, ...answer };
    }

    async search(t: Target, path: string, text: string, where: SearchIn, view: RegistryView): Promise<{ jobId: string; pending: boolean } & Partial<RegistrySearchResult>> {
        const env = { ADG_REG_PATH: path, ADG_REG_VIEW: view, ADG_REG_TEXT: text, ADG_REG_IN: where };
        const { jobId, answer } = await this.tools.run(t, "registry.search", REGISTRY_SCRIPTS.search, env, this.tools.reader("registry.search", t.family, env));
        return { jobId, ...answer };
    }

    async roots(t: Target): Promise<{ jobId: string; pending: boolean } & Partial<RegistryRootsResult>> {
        const { jobId, answer } = await this.tools.run(t, "registry.roots", REGISTRY_SCRIPTS.roots, {}, this.tools.reader("registry.roots", t.family, {}));
        return { jobId, ...answer };
    }

    /** A look or search that was still running, or a change (its record is finalised the first time its result is read). */
    async result(t: Target, jobId: string) {
        return (await this.writes.result(t, jobId)) ?? (await this.tools.result(t, jobId, "registry"));
    }
}
