/**
 * @file    src/lib/purchasing/uline-confirmation.ts
 * @purpose Parse ULINE order confirmation emails from Gmail.
 *          Extracts: order #, PO #, items, prices, totals, tracking.
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
    const shipViaMatch = text.match(/SHIP\s*VIA\s*([\w\s]+?)(?:\s{2,}|$)/i);
    const termsMatch = text.match(/TERMS\s*([\w\s]+?)(?:\s{2,}|$)/i);
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
