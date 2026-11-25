// backend/src/branding/branding.module.ts
import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { BrandingController } from './branding.controller';
import { BrandingService } from './branding.service';

@Module({
    imports: [StorageModule],
    controllers: [BrandingController],
    providers: [BrandingService],
    exports: [BrandingService],
})
export class BrandingModule { }
