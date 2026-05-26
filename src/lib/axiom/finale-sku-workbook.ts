import ExcelJS from "exceljs";

export interface FinaleAxiomProduct {
    productId: string;
    description: string;
    qtyOnHand: number | null;
    stockout: string;
    daysUntilReorder: string;
    salesLast30Days: number | null;
    salesLast60Days: number | null;
    consumptionVelocity: number | null;
    rom: string;
    category: string;
    sublocationSummary: string;
    unitsPerPallet: string;
    grade: string;
    liquid: string;
    supplier: string;
    wholesalePrice: string;
    buildASoilPrice: string;
}

export interface FinaleSkuMappingReviewRow {
    finaleSku: string;
    finaleDescription: string;
    supplier: string;
    category: string;
    rom: string;
    grade: string;
    qtyOnHand: number | null;
    axiomJobName: string;
    finaleSkus: string;
    qtyFraction: number;
    labelSide: "front" | "back" | "single";
    frontBackGroup: string;
    specStatus: "needs_axiom_spec" | "do_not_reorder";
    autoOrderAllowed: "no";
    confidence: "finale_export";
    notes: string;
}

const PRODUCT_LIST_HEADERS: Record<string, keyof FinaleAxiomProduct> = {
    "Product ID": "productId",
    "Description": "description",
    "QoH units": "qtyOnHand",
    "Stockout (configurable)": "stockout",
    "Days until reorder (configurable)": "daysUntilReorder",
    "Sales last 30 days": "salesLast30Days",
    "Sales last 60 days": "salesLast60Days",
    "Consumption velocity (configurable)": "consumptionVelocity",
    "ROM": "rom",
    "Category": "category",
    "Sublocation summary": "sublocationSummary",
    "Units Per Pallet": "unitsPerPallet",
    "Grade": "grade",
    "Liquid": "liquid",
    "Supplier 1": "supplier",
    "Wholesale Price": "wholesalePrice",
    "BuildASoil Price": "buildASoilPrice",
};

const REVIEW_COLUMNS: Array<{ header: string; key: keyof FinaleSkuMappingReviewRow; width: number }> = [
    { header: "finale_sku", key: "finaleSku", width: 18 },
    { header: "finale_description", key: "finaleDescription", width: 56 },
    { header: "supplier", key: "supplier", width: 18 },
    { header: "category", key: "category", width: 18 },
    { header: "rom", key: "rom", width: 18 },
    { header: "grade", key: "grade", width: 10 },
    { header: "qty_on_hand", key: "qtyOnHand", width: 12 },
    { header: "axiom_job_name", key: "axiomJobName", width: 26 },
    { header: "finale_skus", key: "finaleSkus", width: 24 },
    { header: "qty_fraction", key: "qtyFraction", width: 12 },
    { header: "label_side", key: "labelSide", width: 12 },
    { header: "front_back_group", key: "frontBackGroup", width: 22 },
    { header: "spec_status", key: "specStatus", width: 18 },
    { header: "auto_order_allowed", key: "autoOrderAllowed", width: 18 },
    { header: "confidence", key: "confidence", width: 16 },
    { header: "notes", key: "notes", width: 48 },
];

export function parseFinaleProductListCsv(csvText: string): FinaleAxiomProduct[] {
    const records = parseCsv(csvText);
    if (records.length === 0) return [];

    const [headers, ...dataRows] = records;
    return dataRows
        .filter(row => row.some(cell => cell.trim() !== ""))
        .map(row => {
            const raw: Record<string, string> = {};
            headers.forEach((header, index) => {
                raw[header] = row[index] ?? "";
            });

            return {
                productId: rawValue(raw, "Product ID"),
                description: rawValue(raw, "Description"),
                qtyOnHand: nullableNumber(rawValue(raw, "QoH units")),
                stockout: rawValue(raw, "Stockout (configurable)"),
                daysUntilReorder: rawValue(raw, "Days until reorder (configurable)"),
                salesLast30Days: nullableNumber(rawValue(raw, "Sales last 30 days")),
                salesLast60Days: nullableNumber(rawValue(raw, "Sales last 60 days")),
                consumptionVelocity: nullableNumber(rawValue(raw, "Consumption velocity (configurable)")),
                rom: rawValue(raw, "ROM"),
                category: rawValue(raw, "Category"),
                sublocationSummary: rawValue(raw, "Sublocation summary"),
                unitsPerPallet: rawValue(raw, "Units Per Pallet"),
                grade: rawValue(raw, "Grade"),
                liquid: rawValue(raw, "Liquid"),
                supplier: rawValue(raw, "Supplier 1"),
                wholesalePrice: rawValue(raw, "Wholesale Price"),
                buildASoilPrice: rawValue(raw, "BuildASoil Price"),
            };
        });
}

export function buildFinaleSkuMappingReviewRows(products: FinaleAxiomProduct[]): FinaleSkuMappingReviewRow[] {
    return products
        .filter(product => product.productId.trim() !== "")
        .sort((a, b) => a.productId.localeCompare(b.productId))
        .map(product => {
            const finaleSku = product.productId.trim();
            const labelSide = inferLabelSide(finaleSku, product.description);
            return {
                finaleSku,
                finaleDescription: product.description,
                supplier: product.supplier,
                category: product.category,
                rom: product.rom,
                grade: product.grade,
                qtyOnHand: product.qtyOnHand,
                axiomJobName: finaleSku,
                finaleSkus: finaleSku,
                qtyFraction: 1,
                labelSide,
                frontBackGroup: inferFrontBackGroup(finaleSku, product.description),
                specStatus: product.rom.toLowerCase() === "do not reorder" ? "do_not_reorder" : "needs_axiom_spec",
                autoOrderAllowed: "no",
                confidence: "finale_export",
                notes: "",
            };
        });
}

export async function writeFinaleSkuWorkbook(rows: FinaleSkuMappingReviewRow[], outputPath: string): Promise<void> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Aria";
    workbook.created = new Date();

    const review = workbook.addWorksheet("Mapping Review", {
        views: [{ state: "frozen", ySplit: 1 }],
    });
    review.columns = REVIEW_COLUMNS;
    review.addRows(rows);
    styleHeader(review);
    review.autoFilter = {
        from: "A1",
        to: `${review.getColumn(REVIEW_COLUMNS.length).letter}1`,
    };

    const templates = workbook.addWorksheet("Order Templates", {
        views: [{ state: "frozen", ySplit: 1 }],
    });
    templates.columns = [
        { header: "finale_sku", key: "finaleSku", width: 18 },
        { header: "axiom_job_name", key: "axiomJobName", width: 26 },
        { header: "size", key: "size", width: 18 },
        { header: "material", key: "material", width: 28 },
        { header: "finish", key: "finish", width: 20 },
        { header: "roll_direction", key: "rollDirection", width: 18 },
        { header: "turnaround", key: "turnaround", width: 18 },
        { header: "approved", key: "approved", width: 12 },
        { header: "auto_order_allowed", key: "autoOrderAllowed", width: 18 },
        { header: "last_verified_date", key: "lastVerifiedDate", width: 18 },
        { header: "notes", key: "notes", width: 48 },
    ];
    templates.addRows(rows.map(row => ({
        finaleSku: row.finaleSku,
        axiomJobName: row.axiomJobName,
        approved: "no",
        autoOrderAllowed: "no",
        notes: row.specStatus === "do_not_reorder" ? "Finale ROM is Do not reorder." : "",
    })));
    styleHeader(templates);
    templates.autoFilter = {
        from: "A1",
        to: `${templates.getColumn(templates.columns.length).letter}1`,
    };

    const notes = workbook.addWorksheet("Import Notes");
    notes.columns = [
        { header: "topic", key: "topic", width: 28 },
        { header: "note", key: "note", width: 110 },
    ];
    notes.addRows([
        {
            topic: "Primary key",
            note: "Finale SKU is the stable reference. Axiom job/template data is attached to the Finale SKU, not used as the workbook primary key.",
        },
        {
            topic: "Automation gate",
            note: "auto_order_allowed defaults to no. Only set to yes after size/material/finish/roll/turnaround have been verified against Axiom.",
        },
        {
            topic: "Axiom job name",
            note: "Defaults to the Finale SKU as a placeholder. Replace only when the Axiom API/history uses a different job/template identifier.",
        },
        {
            topic: "Front/back groups",
            note: "Rows stay one-per-Finale-SKU. front_back_group only helps review labels that may belong to the same Axiom print job.",
        },
    ]);
    styleHeader(notes);

    await workbook.xlsx.writeFile(outputPath);
}

function styleHeader(worksheet: ExcelJS.Worksheet): void {
    const header = worksheet.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1F2937" },
    };
    header.alignment = { vertical: "middle" };
}

function inferLabelSide(sku: string, description: string): "front" | "back" | "single" {
    const normalizedSku = sku.toUpperCase();
    const normalizedDescription = description.toLowerCase();
    if (normalizedSku.endsWith("LABELFR") || /\bfront\b/.test(normalizedDescription)) return "front";
    if (normalizedSku.endsWith("LABELBK") || /\bback\b/.test(normalizedDescription)) return "back";
    return "single";
}

function inferFrontBackGroup(sku: string, description: string): string {
    const strippedSku = sku
        .replace(/LABELFR$/i, "")
        .replace(/LABELBK$/i, "");
    if (strippedSku !== sku) return strippedSku;

    const normalized = description
        .replace(/\bfront\b/ig, "")
        .replace(/\bback\b/ig, "")
        .replace(/\s+/g, " ")
        .trim();
    return normalized || sku;
}

function nullableNumber(value: string): number | null {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
}

function rawValue(raw: Record<string, string>, header: string): string {
    return (raw[header] ?? "").trim();
}

function parseCsv(csvText: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i];
        const next = csvText[i + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                field += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === "," && !inQuotes) {
            row.push(field);
            field = "";
            continue;
        }

        if ((char === "\n" || char === "\r") && !inQuotes) {
            if (char === "\r" && next === "\n") i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
            continue;
        }

        field += char;
    }

    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    return rows.filter(record => record.some(value => value.trim() !== ""));
}
