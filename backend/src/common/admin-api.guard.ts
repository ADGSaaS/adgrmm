import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { adminKeyMatches } from "./admin-key";

@Injectable()
export class AdminApiGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const key = req.header("x-admin-api-key");
    if (!adminKeyMatches(key)) {
      throw new UnauthorizedException("Invalid or missing x-admin-api-key");
    }
    return true;
  }
}