/**
 * @file    report-pos-week-20260622.ts
 * @purpose One-shot Finale PO report for 2026-06-22..2026-06-26 (session 20260630_095842_78b301)
 * @author  Hermia
 * @created 2026-07-17
 * @deps    finale client
 * @env     FINALE_* via .env.local
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { FinaleClient } from "../src/lib/finale/client";

function isNumericPO(id: string): boolean {
  return /^\d+$/.test(String(id || ""));
}

async function main() {
  const start = "2026-06-22";
  const end = "2026-06-26";
  const finale = new FinaleClient();
  const pos = await finale.getRecentPurchaseOrders(40, 500);
  const inRange = pos.filter((p) => {
    const d = (p.orderDate || "").slice(0, 10);
    return d >= start && d <= end;
  });

  const numeric = inRange.filter((p) => isNumericPO(p.orderId));
  const other = inRange.filter((p) => !isNumericPO(p.orderId));

  const byVendor = (list: typeof pos) => {
    const m = new Map<string, { spend: number; count: number }>();
    for (const p of list) {
      const v = p.vendorName || "(none)";
      const cur = m.get(v) || { spend: 0, count: 0 };
      cur.spend += Number(p.total) || 0;
      cur.count += 1;
      m.set(v, cur);
    }
    return [...m.entries()]
      .map(([vendor, s]) => ({ vendor, ...s }))
      .sort((a, b) => b.spend - a.spend);
  };

  const sum = (list: typeof pos) =>
    list.reduce((a, p) => a + (Number(p.total) || 0), 0);

  // Simple SVG pie by vendor for ops POs
  const vendors = byVendor(numeric);
  const totalOps = sum(numeric) || 1;
  const colors = [
    "#2563eb",
    "#16a34a",
    "#ea580c",
    "#9333ea",
    "#db2777",
    "#0891b2",
    "#ca8a04",
    "#4b5563",
    "#dc2626",
    "#0d9488",
  ];
  let angle = -Math.PI / 2;
  const slices: string[] = [];
  const legend: string[] = [];
  vendors.forEach((v, i) => {
    const frac = v.spend / totalOps;
    const a0 = angle;
    const a1 = angle + frac * Math.PI * 2;
    angle = a1;
    const x0 = 200 + 140 * Math.cos(a0);
    const y0 = 200 + 140 * Math.sin(a0);
    const x1 = 200 + 140 * Math.cos(a1);
    const y1 = 200 + 140 * Math.sin(a1);
    const large = frac > 0.5 ? 1 : 0;
    const color = colors[i % colors.length];
    if (frac > 0) {
      slices.push(
        `<path d="M200,200 L${x0},${y0} A140,140 0 ${large} 1 ${x1},${y1} Z" fill="${color}" stroke="#fff" stroke-width="1"/>`
      );
    }
    legend.push(
      `<rect x="370" y="${40 + i * 22}" width="14" height="14" fill="${color}"/>` +
        `<text x="392" y="${52 + i * 22}" font-family="Segoe UI, sans-serif" font-size="12" fill="#111">${escapeXml(
          v.vendor
        )} $${v.spend.toFixed(0)} (${v.count})</text>`
    );
  });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420">
  <rect width="720" height="420" fill="#fafafa"/>
  <text x="24" y="28" font-family="Segoe UI, sans-serif" font-size="16" font-weight="700" fill="#111">PO Spend by Vendor — ${start} to ${end}</text>
  <text x="24" y="48" font-family="Segoe UI, sans-serif" font-size="12" fill="#555">Ops (numeric PO#) only · Finale source · $${sum(
    numeric
  ).toFixed(2)} across ${numeric.length} POs</text>
  ${slices.join("\n  ")}
  ${legend.join("\n  ")}
</svg>`;

  function escapeXml(s: string) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const report = {
    period: { from: start, to: end },
    generatedAt: new Date().toISOString(),
    source: "Finale GraphQL getRecentPurchaseOrders(daysBack=40)",
    sessionRef: "20260630_095842_78b301",
    opsPOs: {
      count: numeric.length,
      totalSpend: sum(numeric),
      byVendor: vendors,
      rows: [...numeric]
        .sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0))
        .map((p) => ({
          orderId: p.orderId,
          orderDate: p.orderDate,
          vendorName: p.vendorName,
          total: p.total,
          status: p.status,
          expectedDate: p.expectedDate,
          receiveDate: p.receiveDate,
          itemCount: p.items?.length ?? 0,
          items: p.items,
          finaleUrl: p.finaleUrl,
        })),
    },
    otherPOs: {
      count: other.length,
      totalSpend: sum(other),
      note: "Non-numeric PO IDs (dropships, Printful, etc.)",
      byVendor: byVendor(other).slice(0, 20),
      rows: [...other]
        .sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0))
        .slice(0, 50)
        .map((p) => ({
          orderId: p.orderId,
          orderDate: p.orderDate,
          vendorName: p.vendorName,
          total: p.total,
          status: p.status,
        })),
    },
  };

  const outDir = path.join(process.cwd(), "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "purchasing-week-2026-06-22-26.json");
  const svgPath = path.join(outDir, "purchasing-week-2026-06-22-26-vendors.svg");
  const mdPath = path.join(outDir, "purchasing-week-2026-06-22-26.md");

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(svgPath, svg);

  const md = [
    `# Purchasing Report — ${start} → ${end}`,
    ``,
    `Generated: ${report.generatedAt}`,
    `Source: Finale (authoritative)`,
    `Session: 20260630_095842_78b301`,
    ``,
    `## Ops POs (numeric PO#)`,
    `- Count: **${report.opsPOs.count}**`,
    `- Total spend: **$${report.opsPOs.totalSpend.toFixed(2)}**`,
    ``,
    `### By vendor`,
    `| Vendor | POs | Spend |`,
    `|---|---:|---:|`,
    ...vendors.map(
      (v) => `| ${v.vendor} | ${v.count} | $${v.spend.toFixed(2)} |`
    ),
    ``,
    `### PO detail`,
    `| PO | Date | Vendor | Total | Status | Due | Received |`,
    `|---|---|---|---:|---|---|---|`,
    ...report.opsPOs.rows.map(
      (p) =>
        `| ${p.orderId} | ${p.orderDate} | ${p.vendorName} | $${Number(
          p.total || 0
        ).toFixed(2)} | ${p.status} | ${p.expectedDate || "—"} | ${
          p.receiveDate || "—"
        } |`
    ),
    ``,
    `## Other / dropship POs`,
    `- Count: **${report.otherPOs.count}**`,
    `- Total spend: **$${report.otherPOs.totalSpend.toFixed(2)}**`,
    `- Top vendors: ${byVendor(other)
      .slice(0, 5)
      .map((v) => `${v.vendor} $${v.spend.toFixed(0)}`)
      .join("; ")}`,
    ``,
    `Artifacts: \`${path.basename(jsonPath)}\`, \`${path.basename(
      svgPath
    )}\``,
  ].join("\n");

  fs.writeFileSync(mdPath, md);

  console.log(md);
  console.log("\nWrote:");
  console.log(jsonPath);
  console.log(svgPath);
  console.log(mdPath);
  console.log("finale total 40d", pos.length, "in-range", inRange.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
