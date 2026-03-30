const TRUSTED_VENDOR_ALIASES = [
    "uline",
    "axiom",
    "sustainable village",
];

export interface AutoDraftDecisionInput {
    vendorName: string;
    actionableCount: number;
    blockedCount: number;
    highestConfidence: "high" | "medium" | "low" | null;
    cooldownActive: boolean;
}

export function shouldVendorUseAutomation(vendorName: string): boolean {
    const normalized = vendorName.trim().toLowerCase();
    return TRUSTED_VENDOR_ALIASES.some(alias => normalized.includes(alias));
}

export function shouldAutoCreateDraftPO(input: AutoDraftDecisionInput): boolean {
    if (!shouldVendorUseAutomation(input.vendorName)) return false;
    if (input.cooldownActive) return false;
    if (input.actionableCount <= 0) return false;
    if (input.highestConfidence !== "high") return false;
    if (input.blockedCount > input.actionableCount) return false;

    return true;
}
