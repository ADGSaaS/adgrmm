"use client";

// The emailed survey link on the portal's own domain (the domain's /survey is rewritten to here).
import * as React from "react";
import { useSearchParams } from "next/navigation";
import { SurveyPage } from "@/components/surveys/survey-form";

function Inner() {
    const sp = useSearchParams();
    const r = Number(sp.get("r"));
    return <SurveyPage token={sp.get("t") ?? ""} preselect={Number.isInteger(r) && r >= 1 && r <= 5 ? r : null} embedded />;
}

export default function PortalSurveyRoute() {
    return (
        <React.Suspense fallback={null}>
            <Inner />
        </React.Suspense>
    );
}
