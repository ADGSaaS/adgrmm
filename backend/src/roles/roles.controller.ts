import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Req,
} from "@nestjs/common";
import { RolesService } from "./roles.service";
import { CreateRoleDto, UpdateRoleDto } from "./dto";
import { RequirePerm } from "../auth/require-perm.decorator";
import { actorOf } from "../access/grant-rules";

@Controller("/api/roles")
export class RolesController {
    constructor(private readonly svc: RolesService) { }

    @Get()
    @RequirePerm("roles.read")
    list() {
        return this.svc.list();
    }

    @Post()
    @RequirePerm("roles.write")
    create(@Req() req: any, @Body() body: CreateRoleDto) {
        return this.svc.create(actorOf(req), body);
    }

    @Post(":id/duplicate")
    @RequirePerm("roles.write")
    duplicate(
        @Req() req: any,
        @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
        @Body() body: { name?: string },
    ) {
        return this.svc.duplicate(actorOf(req), id, body?.name);
    }

    @Patch(":id")
    @RequirePerm("roles.write")
    async update(
        @Req() req: any,
        @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
        @Body() body: UpdateRoleDto
    ) {
        await this.svc.update(actorOf(req), id, body);
        return { ok: true };
    }

    @Delete(":id")
    @RequirePerm("roles.delete")
    async remove(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
        await this.svc.remove(id);
        return { ok: true };
    }
}
