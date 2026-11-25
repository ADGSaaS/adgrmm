// backend/src/access/device-access.guard.ts
import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ClientAccessService } from "../reports/client-access.service";

/**
 * For routes shaped /api/devices/:id/...: a person limited to some customers gets "not found" for a device that is not
 * one of their customers'. Everyone else passes. It runs after sign-in, so the person is already known.
 */
@Injectable()
export class DeviceAccessGuard implements CanActivate {
    constructor(private readonly access: ClientAccessService) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const id = req?.params?.id;
        if (!id) return true;
        await this.access.assertDevice(req?.user?.id ? String(req.user.id) : null, String(id));
        return true;
    }
}
