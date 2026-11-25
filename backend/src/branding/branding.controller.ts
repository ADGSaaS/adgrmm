// backend/src/branding/branding.controller.ts
import {
    Controller,
    Get,
    Post,
    Body,
    UploadedFile,
    UseInterceptors,
    BadRequestException,
    Req,
} from "@nestjs/common";
import { ApiConsumes, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { existsSync, mkdirSync } from "fs";
import { join, extname } from "path";
import type { Request } from "express";

import { BrandingService } from "./branding.service";
import { UpdateBrandingDto } from "./dto/update-branding.dto";
import { Public } from "../auth/public.decorator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { brandingImageExtension } from "../common/upload-safety";

/** A file-name-safe stem of the original name, without its extension. */
function baseName(original: string | undefined): string {
    const stem = String(original ?? "").replace(/\.[^.]*$/, "");
    return stem.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "upload";
}

// Remove trailing slashes and a trailing /static if present
function sanitizeBaseUrl(raw: string) {
    let base = (raw || "").trim();
    base = base.replace(/\/+$/, ""); // trim trailing slashes
    base = base.replace(/\/static\/?$/i, ""); // drop trailing /static
    return base;
}

@ApiTags("branding")
@Controller("api/branding")
export class BrandingController {
    constructor(private readonly service: BrandingService) { }

    @Get()
    @Public() // ✅ needed for login page + no-auth branding fetch
    @ApiOkResponse({ description: "Current branding settings" })
    getBranding() {
        return this.service.getBranding();
    }

    @Post()
    @RequirePerm("settings.write")
    @ApiOkResponse({ description: "Updated branding settings" })
    updateBranding(@Body() dto: UpdateBrandingDto) {
        return this.service.updateBranding(dto);
    }

    /** Upload general image (logos, login backgrounds). Field name: `file` */
    @Post("upload")
    @RequirePerm("settings.write")
    @ApiConsumes("multipart/form-data")
    @UseInterceptors(
        FileInterceptor("file", {
            storage: diskStorage({
                destination: (_req, _file, cb) => {
                    const dest = join(process.cwd(), "public", "uploads");
                    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
                    cb(null, dest);
                },
                filename: (_req, file, cb) => {
                    // The extension comes from the validated type, never from the name the browser sent.
                    cb(null, `${Date.now()}_${baseName(file.originalname)}${brandingImageExtension(file.mimetype) ?? ".bin"}`);
                },
            }),
            fileFilter: (_req, file, cb) => {
                if (!brandingImageExtension(file.mimetype)) {
                    return cb(new BadRequestException("Only PNG, JPEG, GIF, WebP or ICO images are allowed"), false);
                }
                cb(null, true);
            },
            limits: { fileSize: 5 * 1024 * 1024 },
        }),
    )
    uploadImage(@UploadedFile() file: Express.Multer.File, @Req() req: Request) {
        if (!file) throw new BadRequestException("No file uploaded");

        const rawBase = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
        const base = sanitizeBaseUrl(rawBase);

        // main.ts serves ./public at /static
        return { url: `${base}/static/uploads/${file.filename}` };
    }

    /** Upload favicon (.ico only). Field name: `file` */
    @Post("upload-favicon")
    @RequirePerm("settings.write")
    @ApiConsumes("multipart/form-data")
    @UseInterceptors(
        FileInterceptor("file", {
            storage: diskStorage({
                destination: (_req, _file, cb) => {
                    const dest = join(process.cwd(), "public", "uploads");
                    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
                    cb(null, dest);
                },
                filename: (_req, file, cb) => {
                    cb(null, `${Date.now()}_${baseName(file.originalname)}.ico`);
                },
            }),
            fileFilter: (_req, file, cb) => {
                // Some systems label .ico files application/octet-stream; the file is stored and served as .ico either way.
                const isIco =
                    brandingImageExtension(file.mimetype) === ".ico" ||
                    (file.mimetype === "application/octet-stream" && extname(file.originalname || "").toLowerCase() === ".ico");
                if (!isIco) {
                    return cb(new BadRequestException("Only .ico files are allowed"), false);
                }
                cb(null, true);
            },
            limits: { fileSize: 512 * 1024 },
        }),
    )
    uploadFavicon(@UploadedFile() file: Express.Multer.File, @Req() req: Request) {
        if (!file) throw new BadRequestException("No file uploaded");

        const rawBase = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
        const base = sanitizeBaseUrl(rawBase);

        return { url: `${base}/static/uploads/${file.filename}` };
    }
}
