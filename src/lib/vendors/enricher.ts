import FirecrawlApp from "@mendable/firecrawl-js";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase";

const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY! });
const anthropic = new Anthropic();

export interface VendorProfile {
    id: string;
    name: string;
    normalizedName: string;      // Canonical name for deduplication
    aliases: string[];           // Other names they appear as
    website?: string;
    paymentPortalUrl?: string;
    remitToAddress?: string;
    accountNumber?: string;      // Your account number with them
    paymentTerms?: string;       // Default terms
    preferredPaymentMethod?: string;
    contactName?: string;
    contactEmail?: string;
    contactPhone?: string;
    arEmail?: string;            // Accounts receivable email
    taxId?: string;
    category?: string;           // "Soil Amendments", "Packaging", "Freight", etc.
    notes?: string;
    documentCount: number;
    totalSpend: number;
    averagePaymentDays: number;
    lastOrderDate?: string;
    status: "active" | "inactive" | "on_hold";
}

export async function enrichVendorFromWeb(vendorId: string, vendorName: string) {
    const supabase = createClient();

    // Search for vendor info
    const searchResults = await firecrawl.search(
        `${vendorName} payment portal invoice remit to accounts receivable contact`,
        { limit: 5 }
    );

    const vendorWebsite = searchResults.data?.[0]?.url;

    let enrichedData: Partial<VendorProfile> = {};

    if (vendorWebsite) {
        // Crawl vendor website for AR/payment info
        const crawlResult = await firecrawl.scrapeUrl(vendorWebsite, {
            formats: ["extract"],
            extract: {
                schema: {
                    type: "object",
                    properties: {
                        paymentPortalUrl: { type: "string" },
                        remitToAddress: { type: "string" },
                        arEmail: { type: "string" },
                        contactPhone: { type: "string" },
                        paymentTerms: { type: "string" },
                    }
                }
            }
        });

        // Use LLM to synthesize enriched profile
        const response = await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1024,
            messages: [{
                role: "user",
                content: `Extract vendor contact and payment information from this content for ${vendorName}.
Return JSON: {paymentPortalUrl, remitToAddress, arEmail, contactPhone, paymentTerms, website}

Content: ${JSON.stringify(crawlResult.extract ?? {}).slice(0, 3000)}
Search results: ${searchResults.data?.slice(0, 3).map(r => r.description).join("\n")}`,
            }],
        });

        if (response.content[0].type === "text") {
            try {
                enrichedData = JSON.parse(response.content[0].text.replace(/```json\n?|\n?```/g, ""));
                enrichedData.website = vendorWebsite;
            } catch { /* partial enrichment ok */ }
        }
    }

    // Update vendor in DB
    await supabase.from("vendors").update({
        ...enrichedData,
        last_enriched_at: new Date().toISOString(),
    }).eq("id", vendorId);

    return enrichedData;
}

// Aggregate vendor stats from documents
export async function computeVendorStats(vendorId: string) {
    const supabase = createClient();

    const { data: invoices } = await supabase
        .from("invoices")
        .select("total, invoice_date, status, due_date")
        .eq("vendor_id", vendorId);

    if (!invoices?.length) return;

    const totalSpend = invoices.reduce((sum, inv) => sum + (inv.total ?? 0), 0);
    const paidInvoices = invoices.filter(inv => inv.status === "paid");
    const avgPaymentDays = paidInvoices.length > 0
        ? paidInvoices.reduce((sum, inv) => {
            const invoiceDate = new Date(inv.invoice_date);
            const dueDate = new Date(inv.due_date ?? inv.invoice_date);
            return sum + ((dueDate.getTime() - invoiceDate.getTime()) / 86400000);
        }, 0) / paidInvoices.length
        : 0;

    const lastOrder = invoices.sort((a, b) =>
        new Date(b.invoice_date).getTime() - new Date(a.invoice_date).getTime()
    )[0]?.invoice_date;

    await supabase.from("vendors").update({
        total_spend: totalSpend,
        document_count: invoices.length,
        average_payment_days: Math.round(avgPaymentDays),
        last_order_date: lastOrder,
    }).eq("id", vendorId);
}
