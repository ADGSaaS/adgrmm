// src/health/health.controller.ts
import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator";

@Public()
@Controller()
export class HealthController {
  @Get("/healthz")
  health() {
    return { ok: true, service: "adgrmm-backend", time: new Date().toISOString() };
  }
}
