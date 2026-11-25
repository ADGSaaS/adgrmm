import { Controller, Get, Query, Req } from "@nestjs/common";
import { actorOf } from "../access/grant-rules";
import { SearchService } from "./search.service";

/** GET /api/search?q=text. Any signed-in person may search; each kind of result needs the right to see that kind. */
@Controller("/api/search")
export class SearchController {
    constructor(private readonly search: SearchService) { }

    @Get()
    run(@Req() req: any, @Query("q") q?: string, @Query("limit") limit?: string) {
        return this.search.search(actorOf(req), String(q ?? ""), limit ? Number(limit) : 5);
    }
}
