// backend/src/provisioning/dto/create-installer-bundle.dto.ts
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export type InstallerOs = "windows" | "linux" | "macos";

export class CreateInstallerBundleDto {
    /**
     * Reusable (multi-use) enrollment key created via POST /api/provisioning/enrollment-keys.
     * Raw token is provided by the user UI; backend validates by hashing and checking DB.
     */
    @IsString()
    @MaxLength(512)
    enrollmentKey!: string;

    @IsString()
    @IsIn(["windows", "linux", "macos"])
    os!: InstallerOs;

    /**
     * Optional label used for nicer filename hints.
     * (Example: "Huber Heights" or "STARK Site 1")
     */
    @IsOptional()
    @IsString()
    @MaxLength(80)
    label?: string;

    /**
     * For Group Policy startup scripts and the like, which run on every boot: the script does nothing on a machine
     * that already has the agent installed and enrolled, instead of reinstalling it each time.
     */
    @IsOptional()
    @IsBoolean()
    onlyIfMissing?: boolean;
}

export type CreateInstallerBundleResult = {
    bundleId: string;
    url: string;
    filename: string;
    expiresAt: string; // ISO
    os: InstallerOs;
    clientId: string;
    siteId: string;
    /** One line to paste into an elevated prompt on the target machine. */
    installCommand: string;
    onlyIfMissing: boolean;
};
