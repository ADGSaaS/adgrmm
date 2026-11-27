// backend/src/entitlements/entitlements.controller.ts
import { Controller, Get } from "@nestjs/common";
import { EntitlementsService } from "./entitlements.service";

/** Seat limits and usage for the signed-in person. No permission is needed: it only reports the plan, never changes it. */
@Controller("/api/entitlements")
export class EntitlementsController {
    constructor(private readonly svc: EntitlementsService) { }

    @Get()
    async get() {
        return this.svc.summary();
    }
}
