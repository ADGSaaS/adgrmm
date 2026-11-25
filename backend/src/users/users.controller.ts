import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    Query,
    Req,
    UsePipes,
    ValidationPipe,
} from "@nestjs/common";
import {
    BulkInviteDto,
    CreateUserDto,
    IdParam,
    InviteUserDto,
    ListUsersQuery,
    ResetPasswordDto,
    SuspendDto,
    UpdateRoleDto,
    UpdateUserDto,
} from "./users.dto";
import { UsersService } from "./users.service";
import { RequirePerm } from "../auth/require-perm.decorator";
import { actorOf } from "../access/grant-rules";

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("/api/admin/users")
export class UsersController {
    constructor(private readonly svc: UsersService) { }

    @Get()
    @RequirePerm("users.read")
    async list(@Query() q: ListUsersQuery) {
        return this.svc.list(q);
    }

    @Get("roles")
    @RequirePerm("roles.read")
    async roles() {
        return this.svc.roles();
    }

    @Post("invite")
    @RequirePerm("users.write")
    async invite(@Req() req: any, @Body() body: InviteUserDto) {
        return this.svc.inviteOne(actorOf(req), body);
    }

    @Post("invite/bulk")
    @RequirePerm("users.write")
    async inviteBulk(@Req() req: any, @Body() body: BulkInviteDto) {
        return this.svc.inviteBulk(actorOf(req), body);
    }

    @Post("create")
    @RequirePerm("users.write")
    async create(@Req() req: any, @Body() body: CreateUserDto) {
        return this.svc.createOne(actorOf(req), body);
    }

    @Patch(":id/role")
    @HttpCode(204)
    @RequirePerm(["users.write", "roles.write"])
    async updateRole(@Req() req: any, @Param() p: IdParam, @Body() body: UpdateRoleDto) {
        await this.svc.updateRole(actorOf(req), p.id, body);
    }

    @Patch(":id")
    @HttpCode(204)
    @RequirePerm("users.write")
    async updateUser(@Req() req: any, @Param() p: IdParam, @Body() body: UpdateUserDto) {
        await this.svc.updateUser(actorOf(req), p.id, body);
    }

    // RESET PASSWORD — both PATCH and POST call the same service method
    @Patch(":id/password")
    @HttpCode(204)
    @RequirePerm("users.write")
    async resetPasswordPatch(@Req() req: any, @Param() p: IdParam, @Body() body: ResetPasswordDto) {
        await this.svc.setPassword(actorOf(req), p.id, body);
    }

    @Post(":id/password")
    @HttpCode(204)
    @RequirePerm("users.write")
    async resetPasswordPost(@Req() req: any, @Param() p: IdParam, @Body() body: ResetPasswordDto) {
        await this.svc.setPassword(actorOf(req), p.id, body);
    }

    @Post(":id/reset-2fa")
    @HttpCode(204)
    @RequirePerm("users.2fa.reset")
    async reset2fa(@Req() req: any, @Param() p: IdParam) {
        await this.svc.reset2fa(actorOf(req), p.id);
    }

    @Post(":id/suspend")
    @HttpCode(204)
    @RequirePerm("users.write")
    async suspend(@Req() req: any, @Param() p: IdParam, @Body() body: SuspendDto) {
        await this.svc.setSuspended(actorOf(req), p.id, body.suspended);
    }

    @Delete(":id")
    @HttpCode(204)
    @RequirePerm("users.delete")
    async remove(@Req() req: any, @Param() p: IdParam) {
        await this.svc.remove(actorOf(req), p.id);
    }
}
