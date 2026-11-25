// backend/src/dashboard/dashboard.controller.ts
//
// GET /api/dashboard/summary?clientId=  - everything the Overview page shows, in one answer.
// Any signed-in person may ask; each part of the answer is left out (null) unless they hold the right for it, so nobody
// learns anything here that its own page would not show them. See dashboard.service.ts.
import { Controller, Get, Header, Query, Req, UsePipes, ValidationPipe } from "@nestjs/common";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { DashboardService } from "./dashboard.service";

class SummaryQueryDto {
    @IsOptional() @IsString() @MaxLength(64) clientId?: string;
}

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/dashboard")
export class DashboardController {
    constructor(private readonly dashboard: DashboardService) { }

    @Get("summary")
    @Header("Cache-Control", "no-store")
    summary(@Req() req: any, @Query() q: SummaryQueryDto) {
        return this.dashboard.summary(req, q.clientId);
    }
}
