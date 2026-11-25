// backend/src/reports/client-access.controller.ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UsePipes, ValidationPipe } from "@nestjs/common";
import { IsArray, IsUUID } from "class-validator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ClientAccessService } from "./client-access.service";

class ClientAccessDto {
    @IsArray() @IsUUID("all", { each: true }) clientIds!: string[];
}

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/admin/client-access")
export class ClientAccessController {
    constructor(private readonly access: ClientAccessService) { }

    /** Everyone, and the customers each may see. A person with none listed sees all of them. */
    @Get()
    @RequirePerm("users.write")
    list() {
        return this.access.list();
    }

    @Put(":userId")
    @RequirePerm("users.write")
    set(@Param("userId", new ParseUUIDPipe()) userId: string, @Body() body: ClientAccessDto) {
        return this.access.set(userId, body.clientIds);
    }
}
