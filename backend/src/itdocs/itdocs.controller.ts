// backend/src/itdocs/itdocs.controller.ts
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, UsePipes, ValidationPipe } from "@nestjs/common";
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ASSET_KINDS, ItDocsService, LINK_TYPES } from "./itdocs.service";

class AssetDto {
    @IsUUID("all") clientId!: string;
    @IsString() @MaxLength(200) name!: string;
    @IsIn(ASSET_KINDS as unknown as string[]) kind!: string;
    @IsOptional() @IsString() @MaxLength(200) manufacturer?: string;
    @IsOptional() @IsString() @MaxLength(200) model?: string;
    @IsOptional() @IsString() @MaxLength(200) serialNumber?: string;
    @IsOptional() @IsString() @MaxLength(200) location?: string;
    @IsOptional() @IsString() purchaseDate?: string;
    @IsOptional() @IsString() expiresAt?: string;
    @IsOptional() @IsString() @MaxLength(10_000) notes?: string;
}

class LinkDto {
    @IsIn(LINK_TYPES as unknown as string[]) fromType!: string;
    @IsUUID("all") fromId!: string;
    @IsIn(LINK_TYPES as unknown as string[]) toType!: string;
    @IsUUID("all") toId!: string;
}

class ListQuery {
    @IsOptional() @IsUUID("all") clientId?: string;
    @IsOptional() @IsString() @MaxLength(200) q?: string;
    @IsOptional() @IsString() kind?: string;
    @IsOptional() @IsString() templates?: string;
}

const userOf = (req: any): string | null => req?.user?.id ?? null;

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/docs")
export class ItDocsController {
    constructor(private readonly docs: ItDocsService) { }

    /* assets */

    @Get("assets")
    @RequirePerm("assets.read")
    assets(@Req() req: any, @Query() query: ListQuery) {
        return this.docs.listAssets(query, req?.user?.id ? String(req.user.id) : null);
    }

    @Post("assets/sync")
    @HttpCode(200)
    @RequirePerm("assets.write")
    sync() {
        return this.docs.syncFromAgents();
    }

    @Post("assets")
    @RequirePerm("assets.write")
    createAsset(@Req() req: any, @Body() body: AssetDto) {
        return this.docs.createAsset(body, req?.user?.id ? String(req.user.id) : null);
    }

    @Put("assets/:id")
    @RequirePerm("assets.write")
    updateAsset(@Req() req: any, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: AssetDto) {
        return this.docs.updateAsset(id, body, req?.user?.id ? String(req.user.id) : null);
    }

    @Delete("assets/:id")
    @RequirePerm("assets.write")
    deleteAsset(@Req() req: any, @Param("id", new ParseUUIDPipe()) id: string) {
        return this.docs.deleteAsset(id, req?.user?.id ? String(req.user.id) : null);
    }

    @Get("expiring")
    @RequirePerm("assets.read")
    expiring(@Req() req: any, @Query("days") days?: string) {
        return this.docs.expiring(Math.min(Math.max(Number(days) || 90, 1), 730), req?.user?.id ? String(req.user.id) : null);
    }

    /* links */

    @Get("links")
    @RequirePerm("tickets.read")
    links(@Query("type") type: string, @Query("id", new ParseUUIDPipe()) id: string) {
        return this.docs.listLinks(type, id);
    }

    @Get("link-targets")
    @RequirePerm("tickets.read")
    linkTargets(@Query("type") type: string, @Query("q") q?: string) {
        return this.docs.linkTargets(type, q ?? "");
    }

    @Post("links")
    @RequirePerm("tickets.write")
    addLink(@Body() body: LinkDto, @Req() req: any) {
        return this.docs.addLink(body, userOf(req));
    }

    @Delete("links/:id")
    @RequirePerm("tickets.write")
    removeLink(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.docs.removeLink(id);
    }
}
