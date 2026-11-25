import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Req } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { actorOf } from "../access/grant-rules";
import { GroupInput, GroupsService } from "./groups.service";

@Controller("/api/admin")
export class GroupsController {
    constructor(private readonly groups: GroupsService) { }

    @Get("groups")
    @RequirePerm("groups.read")
    list() {
        return this.groups.list();
    }

    @Get("groups/:id")
    @RequirePerm("groups.read")
    get(@Param("id") id: string) {
        return this.groups.get(id);
    }

    @Post("groups")
    @RequirePerm("groups.write")
    create(@Req() req: any, @Body() body: GroupInput) {
        return this.groups.create(actorOf(req), body ?? {});
    }

    @Patch("groups/:id")
    @RequirePerm("groups.write")
    async update(@Req() req: any, @Param("id") id: string, @Body() body: GroupInput) {
        await this.groups.update(actorOf(req), id, body ?? {});
        return { ok: true };
    }

    @Delete("groups/:id")
    @RequirePerm("groups.write")
    async remove(@Param("id") id: string) {
        await this.groups.remove(id);
        return { ok: true };
    }

    /** Which groups one person is in (replaces the list). */
    @Put("users/:id/groups")
    @HttpCode(204)
    @RequirePerm(["users.write", "groups.write"])
    async setUserGroups(@Req() req: any, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: { groupIds?: string[] }) {
        await this.groups.setUserGroups(actorOf(req), id, body?.groupIds ?? []);
    }

    /** Everything this person can do and see, and where each piece comes from. */
    @Get("users/:id/access")
    @RequirePerm("users.read")
    access(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.groups.accessOf(id);
    }
}
