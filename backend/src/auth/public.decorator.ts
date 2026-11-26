import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "adgrmm:isPublic";


/**
 * Mark a route/controller as publicly accessible (bypass GlobalAuthGuard).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
