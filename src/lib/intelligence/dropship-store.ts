/**
 * @file    dropship-store.ts
 * @purpose In-memory store for unmatched invoices pending dropship forwarding.
 *          Same pattern as pendingApprovals in reconciler.ts.
 *          The bot's dropship_fwd_* callback retrieves from here to forward to bill.com.
 * @author  Aria
 * @created 2026-02-27
 */

export interface PendingDropship {
    id: string;
    invoiceNumber: string;
    vendorName: string;
    total: number;
    subject: string;
    from: string;
    filename: string;
    base64Pdf: string;   // standard base64 (not URL-safe)
    createdAt: number;
}

const EXPIRY_MS = 48 * 60 * 60 * 1000; // 48 hours

const pendingDropships = new Map<string, PendingDropship>();

export function storePendingDropship(data: Omit<PendingDropship, 'id' | 'createdAt'>): string {
    const id = `drop_${data.invoiceNumber.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;
    pendingDropships.set(id, { ...data, id, createdAt: Date.now() });
    setTimeout(() => pendingDropships.delete(id), EXPIRY_MS);
    return id;
}

export function getPendingDropship(id: string): PendingDropship | null {
    const entry = pendingDropships.get(id);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > EXPIRY_MS) {
        pendingDropships.delete(id);
        return null;
    }
    return entry;
}

export function removePendingDropship(id: string): void {
    pendingDropships.delete(id);
}

/** Returns all pending dropship IDs (for "Please forward" text fallback) */
export function getAllPendingDropships(): PendingDropship[] {
    const now = Date.now();
    const result: PendingDropship[] = [];
    for (const [id, entry] of pendingDropships) {
        if (now - entry.createdAt <= EXPIRY_MS) {
            result.push(entry);
        } else {
            pendingDropships.delete(id);
        }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
}
