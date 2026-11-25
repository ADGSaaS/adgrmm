// backend/src/device-metrics/device-metrics.controller.ts
import { Controller, Get, NotFoundException, Param, Query, UseGuards } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { DeviceAccessGuard } from "../access/device-access.guard";
import { DeviceMetricsService, type MetricRange } from "./device-metrics.service";

@UseGuards(DeviceAccessGuard)
@Controller("api/devices/:id")
export class DeviceMetricsController {
    constructor(private readonly metrics: DeviceMetricsService) { }

    /** CPU, memory and disk over 1h, 12h, 24h, 7d or 30d, averaged into buckets (5 minutes, 30 minutes, 2 hours). */
    @Get("metrics")
    @RequirePerm("devices.read")
    async series(@Param("id") id: string, @Query("range") range?: string) {
        const deviceId = await this.metrics.resolveDevice(id);
        if (!deviceId) throw new NotFoundException("Device not found");
        const r: MetricRange = range === "1h" || range === "12h" || range === "7d" || range === "30d" ? range : "24h";
        return this.metrics.series(deviceId, r);
    }

    /** The daily availability and disk-free history, up to 800 days. */
    @Get("daily-history")
    @RequirePerm("devices.read")
    async daily(@Param("id") id: string, @Query("days") days?: string) {
        const deviceId = await this.metrics.resolveDevice(id);
        if (!deviceId) throw new NotFoundException("Device not found");
        return this.metrics.daily(deviceId, Number(days) || 90);
    }
}
