// backend/src/reports/client-branding.controller.ts
import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Req, UploadedFile, UseInterceptors, UsePipes, ValidationPipe } from "@nestjs/common";
import type { Request } from "express";
import { FileInterceptor } from "@nestjs/platform-express";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { diskStorage } from "multer";
import { existsSync, mkdirSync } from "node:fs";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ClientBrandingService, UPLOADS_DIR } from "./client-branding.service";
import { ClientAccessService } from "./client-access.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ClientBrandingDto {
    @IsOptional() @IsString() @MaxLength(7) primaryColor?: string;
    @IsOptional() @IsString() @MaxLength(1500) coverText?: string;
    @IsOptional() @IsString() @MaxLength(160) footerText?: string;
}

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/reports/branding")
export class ClientBrandingController {
    constructor(private readonly branding: ClientBrandingService, private readonly access: ClientAccessService) { }

    @Get(":clientId")
    @RequirePerm("devices.read")
    async get(@Param("clientId", new ParseUUIDPipe()) clientId: string, @Req() req: Request) {
        this.access.assertClient(await this.access.allowedFor((req as any)?.user?.id ? String((req as any).user.id) : null), clientId);
        return this.branding.get(clientId);
    }

    @Put(":clientId")
    @RequirePerm("settings.write")
    set(@Param("clientId", new ParseUUIDPipe()) clientId: string, @Body() body: ClientBrandingDto) {
        return this.branding.set(clientId, body);
    }

    /** A customer's logo for their reports. PNG or JPEG, up to 2 MB. Field name: file. */
    @Post(":clientId/logo")
    @RequirePerm("settings.write")
    @UseInterceptors(
        FileInterceptor("file", {
            storage: diskStorage({
                destination: (_req, _file, cb) => {
                    const dest = UPLOADS_DIR();
                    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
                    cb(null, dest);
                },
                filename: (req, file, cb) => {
                    const id = String((req as any).params?.clientId ?? "");
                    if (!UUID.test(id)) return cb(new BadRequestException("That customer id is not valid."), "");
                    cb(null, `client-logo-${id}-${Date.now()}.${file.mimetype === "image/png" ? "png" : "jpg"}`);
                },
            }),
            fileFilter: (_req, file, cb) => {
                if (file.mimetype !== "image/png" && file.mimetype !== "image/jpeg") return cb(new BadRequestException("The logo must be a PNG or JPEG image."), false);
                cb(null, true);
            },
            limits: { fileSize: 2 * 1024 * 1024 },
        }),
    )
    uploadLogo(@Param("clientId", new ParseUUIDPipe()) clientId: string, @UploadedFile() file: Express.Multer.File) {
        if (!file) throw new BadRequestException("Choose a PNG or JPEG image.");
        return this.branding.setLogo(clientId, file.filename);
    }

    @Delete(":clientId/logo")
    @RequirePerm("settings.write")
    removeLogo(@Param("clientId", new ParseUUIDPipe()) clientId: string) {
        return this.branding.removeLogo(clientId);
    }
}
