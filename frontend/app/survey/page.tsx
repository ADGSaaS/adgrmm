"use client";

// The page the emailed survey link opens. No sign-in: the signed link is the credential.
import * as React from "react";
import { useSearchParams } from "next/navigation";
import { SurveyPage } from "@/components/surveys/survey-form";

function Inner() {
    const sp = useSearchParams();
    const r = Number(sp.get("r"));
    return <SurveyPage token={sp.get("t") ?? ""} preselect={Number.isInteger(r) && r >= 1 && r <= 5 ? r : null} />;
}

export default function SurveyRoute() {
    return (
        <React.Suspense fallback={null}>
            <Inner />
        </React.Suspense>
    );
}
