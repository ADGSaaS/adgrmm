import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ScriptSnippetsService } from "./script-snippets.service";

type Body_ = { title?: string; description?: string; language?: string; body?: string; shared?: boolean };

/** Script snippets: code a person keeps for themselves or shares, to put into scripts. Reading needs automation.read, writing automation.run. */
@Controller("api/script-snippets")
export class ScriptSnippetsController {
    constructor(private readonly snippets: ScriptSnippetsService) { }

    @Get()
    @RequirePerm("automation.read")
    async list(@Req() req: any) {
        return { items: await this.snippets.list(req) };
    }

    @Post()
    @RequirePerm("automation.run")
    create(@Req() req: any, @Body() body: Body_) {
        return this.snippets.create(req, body ?? {});
    }

    @Patch(":id")
    @RequirePerm("automation.run")
    update(@Req() req: any, @Param("id") id: string, @Body() body: Body_) {
        return this.snippets.update(req, id, body ?? {});
    }

    @Delete(":id")
    @RequirePerm("automation.run")
    remove(@Req() req: any, @Param("id") id: string) {
        return this.snippets.remove(req, id);
    }
}
