import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, Length, Matches, ValidateNested } from 'class-validator';

export class SubmitSoftwareItemDto {
    @IsString()
    @Length(1, 256)
    name!: string;

    @IsOptional()
    @IsString()
    @Length(1, 128)
    version?: string;

    @IsOptional()
    @IsString()
    @Length(1, 256)
    publisher?: string;

    // YYYY-MM-DD
    @IsOptional()
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'installDate must be YYYY-MM-DD' })
    installDate?: string;

    // "machine" (installed for everyone) or "user" (installed under one user's profile)
    @IsOptional()
    @IsIn(['machine', 'user'])
    scope?: 'machine' | 'user';

    // For scope "user": the account that owns the install
    @IsOptional()
    @IsString()
    @Length(0, 256)
    user?: string | null;

    // Best effort: who ran the installer
    @IsOptional()
    @IsString()
    @Length(0, 256)
    installedBy?: string | null;
}

export class SubmitSoftwareUserDto {
    @IsString()
    @Length(1, 256)
    account!: string;

    @IsOptional()
    loggedIn?: boolean;
}

export class SubmitSoftwareDto {
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SubmitSoftwareItemDto)
    items!: SubmitSoftwareItemDto[];

    // The accounts on the device and whether each is signed in right now (so installs can be aimed at a user)
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SubmitSoftwareUserDto)
    users?: SubmitSoftwareUserDto[];
}
