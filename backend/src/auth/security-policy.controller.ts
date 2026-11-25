import { BadRequestException, Body, Controller, Get, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "./public.decorator";
import { RequirePerm } from "./require-perm.decorator";
import { SecurityPolicyInput, SecurityPolicyService } from "./security-policy.service";

const orgOf = (req: Request): string => {
    const u = (req as any)?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    if (!org) throw new BadRequestException("No organization in the session.");
    return String(org);
};

/** The sign-in page asks this before anyone is signed in. */
@Controller("api/auth")
export class LoginConfigController {
    constructor(private readonly policy: SecurityPolicyService) { }

    @Public()
    @Get("login-config")
    config() {
        return this.policy.loginConfig();
    }
}

/** Administration > Security Policies. */
@Controller("api/admin/security-policies")
export class SecurityPolicyController {
    constructor(private readonly policy: SecurityPolicyService) { }

    @Get()
    @RequirePerm("settings.read")
    get(@Req() req: Request) {
        return this.policy.get(orgOf(req), req);
    }

    @Put()
    @RequirePerm("settings.write")
    save(@Req() req: Request, @Body() body: SecurityPolicyInput) {
        const u = (req as any).user;
        return this.policy.save(orgOf(req), { id: String(u.id), email: u.email }, body && typeof body === "object" ? body : {}, req);
    }
}
