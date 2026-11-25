import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService
    extends PrismaClient
    implements OnModuleInit, OnModuleDestroy {
    constructor() {
        super({ errorFormat: "minimal" });

        // Validation errors repeat the query's arguments, even in minimal format. Those
        // can be passwords or private keys, and thrown errors end up in the logs.
        this.$use(async (params, next) => {
            try {
                return await next(params);
            } catch (e) {
                if (e instanceof Prisma.PrismaClientValidationError) {
                    throw new Error(`Invalid data for ${params.model ?? "query"}.${params.action}`);
                }
                throw e;
            }
        });
    }

    async onModuleInit(): Promise<void> {
        await this.$connect();
    }

    async onModuleDestroy(): Promise<void> {
        await this.$disconnect();
    }
}
