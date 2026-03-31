import type { Page } from "playwright";

const SKIP_BUTTON_LABELS = ["Purchases", "Overdue", "Purchase Request", "Tutorial"];

export type VendorButtonSnapshot = {
  text: string;
  isVisible: boolean;
};

export function normalizeVendorChipLabel(rawLabel: string): string | null {
  const text = rawLabel.trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (SKIP_BUTTON_LABELS.some((label) => text.includes(label))) {
    return null;
  }

  const match = text.match(/^(.*?)(?:\s+)?(\d+)$/);
  if (!match) return null;

  const name = match[1].trim();
  return name.length > 0 ? name : null;
}

export function extractVendorChipNames(buttons: VendorButtonSnapshot[]): string[] {
  const names = new Set<string>();

  for (const button of buttons) {
    if (!button.isVisible) continue;
    const name = normalizeVendorChipLabel(button.text);
    if (name) names.add(name);
  }

  return [...names];
}

export async function snapshotVendorButtons(page: Page): Promise<VendorButtonSnapshot[]> {
  const allButtons = await page.locator("button").all();
  const snapshots: VendorButtonSnapshot[] = [];

  for (const button of allButtons) {
    const text = (await button.textContent())?.trim() || "";
    const isVisible = await button.isVisible().catch(() => false);
    snapshots.push({ text, isVisible });
  }

  return snapshots;
}

export async function clickVendorChip(page: Page, vendorName: string): Promise<void> {
  const escapedVendorName = vendorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const chipPattern = new RegExp(`^${escapedVendorName}\\s*\\d+$`, "i");
  const chip = page
    .locator("button")
    .filter({ hasText: chipPattern })
    .first();

  await chip.waitFor({ state: "visible", timeout: 15_000 });
  await chip.click();
}
