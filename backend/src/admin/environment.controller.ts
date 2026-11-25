import {
    Controller,
    Get,
    Res,
    UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { HumanSessionGuard } from "../auth/human-session.guard";
import { EnvironmentService } from "./environment.service";

@Controller("/api/admin/environment")
@UseGuards(HumanSessionGuard)
export class EnvironmentController {
    constructor(
        private readonly environment: EnvironmentService,
    ) {}

    @Get()
    @RequirePerm("settings.environment.read")
    list(@Res({ passthrough: true }) res: Response) {
        res.setHeader(
            "Cache-Control",
            "private, no-store, max-age=0",
        );
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("Vary", "Cookie, Authorization");

        return this.environment.list();
    }
}
