import {
    Body,
    Controller,
    Get,
    HttpCode,
    Post,
    Req,
    UnauthorizedException,
    UsePipes,
    ValidationPipe,
} from "@nestjs/common";
import { LocalizationService } from "./localization.service";
import { LocalizationDto, LocalizationRow } from "./localization.dto";
import { RequirePerm } from "../auth/require-perm.decorator";

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("/api/admin/localization")
export class LocalizationController {
    constructor(private readonly svc: LocalizationService) { }

    private getOrganizationId(req: any): string {
        const organizationId = req?.user?.organizationId;
        if (!organizationId) {
            throw new UnauthorizedException("Organization context is unavailable");
        }
        return String(organizationId);
    }

    @Get()
    @RequirePerm("settings.read")
    async get(@Req() req: any): Promise<LocalizationRow | { exists: false }> {
        const row = await this.svc.get(this.getOrganizationId(req));
        return row ?? { exists: false };
    }

    @Post("save")
    @HttpCode(204)
    @RequirePerm("settings.write")
    async save(@Req() req: any, @Body() body: LocalizationDto): Promise<void> {
        await this.svc.upsert(this.getOrganizationId(req), body);
    }
}
