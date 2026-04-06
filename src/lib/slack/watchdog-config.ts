export function resolveSlackPollInterval(rawValue: string | undefined): number {
    const parsed = parseInt(rawValue || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 180;
}

export function isSlackAutoDraftPOEnabled(rawValue: string | undefined): boolean {
    const normalized = (rawValue || "").trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
}
