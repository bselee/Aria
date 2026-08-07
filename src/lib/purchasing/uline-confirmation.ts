/**
 * @file    src/lib/purchasing/uline-confirmation.ts
 * @purpose Parse ULINE order confirmation emails from Gmail.
 *          Extracts: order #, PO #, items, prices, totals, tracking.
 *          Enforces required Ship Via: Freight Collect + FEDEX FREIGHT
 *          (Uline calls FedEx → bill lands on general FedEx Billing Online,
 *          not LTL Select Invoice Center).
 * @source  Pattern derived from: customer.service@uline.com confirmation emails
 */

export interface UlineConfirmationItem {
    qty: number;
    unit: string;
    itemNumber: string;
    description: string;
    unitPrice: number;
    extendedPrice: number;
    taxable: boolean;
    isKitComponent: boolean;
}

export interface UlineOrderConfirmation {
    orderNumber: string;
    poNumber: string | null;
    orderDate: string;
    shipDate: string | null;
    customerNumber: string;
    shipVia: string;
    terms: string;
    items: UlineConfirmationItem[];
    subtotal: number;
    tax: number;
    shipping: number;
    total: number;
    gmailMessageId: string;
}

/**
 * Required Uline Ship Via (checkout / confirmation).
 * Freight Collect + FEDEX FREIGHT → Uline calls FedEx COLLECT;
 * carrier invoice hits **general FedEx Billing Online** (not LTL Select).
 */
export const ULINE_REQUIRED_SHIP_VIA = "Freight Collect FEDEX FREIGHT";

/** True when shipVia is Freight Collect and FEDEX FREIGHT (case/space flexible). */
export function isUlineRequiredShipVia(shipVia: string | null | undefined): boolean {
    const s = String(shipVia || "")
        .toUpperCase()
        .replace(/[\s_/,-]+/g, " ")
        .trim();
    if (!s) return false;
    const freightCollect =
        /\bFREIGHT\s+COLLECT\b/.test(s) || /\bCOLLECT\s+FREIGHT\b/.test(s);
    const fedexFreight = /\bFEDEX\s+FREIGHT\b/.test(s) || /\bFXFE\b/.test(s) || /\bFXF\b/.test(s);
    return freightCollect && fedexFreight;
}

/**
 * Human-readable check for confirmations / cart review.
 * @returns ok + reasons when shipVia is wrong or missing
 */
export function checkUlineShipVia(shipVia: string | null | undefined): {
    ok: boolean;
    shipVia: string;
    required: string;
    reasons: string[];
} {
    const raw = String(shipVia || "").trim();
    const reasons: string[] = [];
    if (!raw) {
        reasons.push("missing Ship Via");
    } else if (!isUlineRequiredShipVia(raw)) {
        const up = raw.toUpperCase();
        if (!/\bFREIGHT\s+COLLECT\b/.test(up) && !/\bCOLLECT\s+FREIGHT\b/.test(up)) {
            reasons.push("must be Freight Collect (not prepaid / third-party)");
        }
        if (!/\bFEDEX\s+FREIGHT\b/.test(up) && !/\bFXFE\b/.test(up) && !/\bFXF\b/.test(up)) {
            reasons.push("must be FEDEX FREIGHT (not UPS / parcel / Uline truck)");
        }
        if (reasons.length === 0) {
            reasons.push(`expected "${ULINE_REQUIRED_SHIP_VIA}", got "${raw}"`);
        }
    }
    return {
        ok: reasons.length === 0,
        shipVia: raw,
        required: ULINE_REQUIRED_SHIP_VIA,
        reasons,
    };
}

function decodeBody(payload: any): string {
    if (payload?.body?.data) return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    if (payload?.parts) {
        for (const part of payload.parts) {
            const d = decodeBody(part);
            if (d) return d;
        }
    }
    return '';
}

function extractText(html: string): string {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ').trim();
}

export function parseUlineConfirmationEmail(
    subject: string,
    body: string,
    gmailMessageId: string,
): UlineOrderConfirmation | null {
    const text = extractText(body);

    const orderMatch = text.match(/ORDER\s*#\s*(\d+)/i);
    const poMatch = text.match(/PO\s*#\s*(\d+)/i);
    const orderDateMatch = text.match(/ORDER\s*DATE\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
    const shipDateMatch = text.match(/SHIP\s*DATE\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
    const custMatch = text.match(/CUSTOMER\s*NUMBER\s*(\d+)/i);
    // Ship Via / Terms: stop at next known header (single-spaced HTML→text collapses \s{2,}).
    const shipViaMatch = text.match(
        /SHIP\s*VIA\s+(.+?)(?=\s+(?:TERMS|QUANTITY|SUB[-\s]*TOTAL|ORDER\s*#|PO\s*#|CUSTOMER)|$)/i,
    );
    const termsMatch = text.match(
        /TERMS\s+(.+?)(?=\s+(?:SHIP\s*VIA|QUANTITY|SUB[-\s]*TOTAL|ORDER\s*#|PO\s*#|CUSTOMER)|$)/i,
    );
    const subtotalMatch = text.match(/SUB[\-\s]*TOTAL\s+\$?([\d,]+\.\d{2})/i);
    const taxMatch = text.match(/(?:SALES\s*)?TAX\s+\$?([\d,]+\.\d{2})/i);
    const shippingMatch = text.match(/(?:SHIPPING|HANDLING)\s+\$?([\d,]+\.\d{2})/i);
    const totalMatch = text.match(/(?:GRAND\s*)?TOTAL\s+\$?([\d,]+\.\d{2})/i);

    if (!orderMatch) return null;

    const items: UlineConfirmationItem[] = [];

    // ULINE item line format:
    // QTY U/M ITEM# DESCRIPTION UNIT_PRICE EXT_PRICE [T]
    // Examples:
    //   4 EA H-4987 3M 6503 HALF-FACE RESPIRATOR - LARGE 35.00 140.00 T
    //   1,300 EA S-4122 12 X 12 X 6" CORRUGATED BOXES .99 1,287.00 T
    //   120 EA S-13507CAP 38/400 WHITE PP CAP 60/BG .00 .00 PART OF KIT
    //   1 PL S-3902 SILICA GEL DESICCANTS - GRAM SIZE 1, 5 GALLON PAIL 195.00 195.00 T
    //   2 CT S-1748 24 X 42" 2 MIL INDUSTRIAL POLY BAGS 93.00 186.00 T
    const lineRegex = /(\d[\d,]*)\s+(EA|RL|CT|BX|KT|PL|PR|SH|UN)\s+([A-Z]?\d+[\-\dA-Z]*)\s+(.+?)\s+([\d]+\.\d{2})\s+([\d,]+\.\d{2})(?:\s+(T|PART OF KIT))?/gi;

    // Find the items section between "QUANTITY U/M" and "SUB"
    const qtyHeaderIdx = text.indexOf('QUANTITY U/M');
    const subtotalIdx = text.indexOf('SUB');
    if (qtyHeaderIdx >= 0 && subtotalIdx > qtyHeaderIdx) {
        const itemsText = text.substring(qtyHeaderIdx, subtotalIdx);
        let m;
        while ((m = lineRegex.exec(itemsText)) !== null) {
            const rawQty = m[1].replace(/,/g, '');
            const unit = m[2];
            const itemNumber = m[3];
            const description = m[4].trim();
            const unitPrice = Number(m[5]);
            const extendedPrice = Number(m[6].replace(/,/g, ''));
            const flag = (m[7] || '').trim().toUpperCase();
            items.push({
                qty: Number(rawQty),
                unit,
                itemNumber,
                description,
                unitPrice,
                extendedPrice,
                taxable: flag === 'T',
                isKitComponent: flag === 'PART OF KIT',
            });
        }
    }

    return {
        orderNumber: orderMatch[1],
        poNumber: poMatch?.[1] || null,
        orderDate: orderDateMatch?.[1] || '',
        shipDate: shipDateMatch?.[1] || null,
        customerNumber: custMatch?.[1] || '',
        shipVia: shipViaMatch?.[1]?.trim() || '',
        terms: termsMatch?.[1]?.trim() || '',
        items,
        subtotal: subtotalMatch ? Number(subtotalMatch[1].replace(/,/g, '')) : 0,
        tax: taxMatch ? Number(taxMatch[1].replace(/,/g, '')) : 0,
        shipping: shippingMatch ? Number(shippingMatch[1].replace(/,/g, '')) : 0,
        total: totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : 0,
        gmailMessageId,
    };
}

export { decodeBody };
