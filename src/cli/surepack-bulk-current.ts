console.log("=".repeat(120));
console.log("  SUREPACK BULK PURCHASE — CURRENT DEMAND (live stock, Uline CSV burn)");
console.log("  Stock refreshed from Finale — PO 124621 landed & accounted");
console.log("=".repeat(120));
console.log("");

// Current live stock (from Finale check just now)
const SIZES = [
    { size: '22×14×6', mo: 2250, daily: 74.2,
      stock: { uline: 507, surepack: 900 }, // S-4796 + SP22146
      priceUline: 1.99, priceSurepack: 1.73, pack: 20,
      note: '🚨 Critical — 19 days left' },
    { size: '12×12×6',  mo: 883,  daily: 29.1,
      stock: { uline: 691, surepack: 3130 }, // S-4122 + SP12126
      priceUline: 0.99, priceSurepack: 0.86, pack: 25,
      note: 'Well stocked (3.5mo SP)' },
    { size: '12×12×12', mo: 250,  daily: 8.2,
      stock: { uline: 494, surepack: 0 }, // S-4125 + SP-121212
      priceUline: 1.09, priceSurepack: 1.00, pack: 25,
      note: 'Switch candidate' },
    { size: '30×15×15', mo: 118,  daily: 3.9,
      stock: { uline: 120, surepack: 0 }, // ULS455 + SP301515
      priceUline: 3.33, priceSurepack: 3.12, pack: 15,
      note: 'Switch candidate' },
];

const COVERAGE = [3, 6, 12];

// Print current snapshot first
console.log("\nCURRENT SNAPSHOT:\n");
console.log(pad("Size", 16) + pad("Burn/day", 10) + pad("Burn/mo", 10) + pad("SP Stock", 10) + pad("Uline Stock", 12) + pad("Total", 8) + pad("Runway", 8));
console.log("-".repeat(100));
for (const s of SIZES) {
    const total = s.stock.uline + s.stock.surepack;
    const runway = Math.round(total / s.daily);
    const emoji = runway < 30 ? '🔴' : runway < 60 ? '🟡' : '✅';
    console.log(
        pad(s.size, 16) +
        pad(String(s.daily), 10) +
        pad(String(s.mo), 10) +
        pad(String(s.stock.surepack), 10) +
        pad(String(s.stock.uline), 12) +
        pad(String(total), 8) +
        pad(`${runway}d ${emoji}`, 8)
    );
}

// Build scenarios
for (const cov of COVERAGE) {
    console.log(`\n\n━━━ ${cov}-MONTH BULK (covers through ${cov === 3 ? 'Oct' : cov === 6 ? 'Jan' : 'Jul 2027'}) ━━━`);
    console.log("");

    let orderTotal = 0;
    let savingsTotal = 0;
    const lines: string[] = [];

    for (const s of SIZES) {
        const totalNeed = s.mo * cov;
        const stockTotal = s.stock.uline + s.stock.surepack;

        // Runway with current stock
        const runwayMo = (stockTotal / s.mo).toFixed(1);

        // If stock already covers the coverage period, skip
        if (stockTotal >= totalNeed) {
            console.log(`  ${pad(s.size, 16)} Already ${runwayMo}mo stock — skip`);
            continue;
        }

        // Need = total needed - current stock
        let toOrder = totalNeed - stockTotal;
        if (toOrder <= 0) {
            console.log(`  ${pad(s.size, 16)} Already ${runwayMo}mo stock — skip`);
            continue;
        }

        // Snap to pack size
        toOrder = Math.ceil(toOrder / s.pack) * s.pack;

        const costSP = toOrder * s.priceSurepack;
        const costUline = toOrder * s.priceUline;
        const savings = costUline - costSP;
        const packs = toOrder / s.pack;

        orderTotal += costSP;
        savingsTotal += savings;

        const totalAfter = stockTotal + toOrder;
        const moCovered = (totalAfter / s.mo).toFixed(1);

        console.log(
            `  ${pad(s.size, 16)}` +
            `${pad(String(toOrder), 8)} (${pad(String(packs), 4)} packs)` +
            `  $${pad(Math.round(costSP).toLocaleString(), 7)}` +
            `  saves $${pad(Math.round(savings).toLocaleString(), 5)}` +
            `  → ${pad(moCovered + 'mo total', 10)}  ${s.note}`
        );

        lines.push(`    ${s.size}: x${toOrder} (${packs} packs) @ $${s.priceSurepack.toFixed(3)} = $${Math.round(costSP).toLocaleString()}`);
    }

    console.log(`  ${''.padEnd(51)} ———————     ———————`);
    console.log(`  ${''.padEnd(51)} $${Math.round(orderTotal).toLocaleString()}    saves $${Math.round(savingsTotal).toLocaleString()}`);
    console.log("");
    for (const l of lines) console.log(l);
}

// Recommendation
console.log("\n\n══════════════════════════════════════════════════════════════════");
console.log("  RECOMMENDATION");
console.log("══════════════════════════════════════════════════════════════════");
console.log("");
console.log("  22×14×6 is at 19 days — order first. 6-month bulk is the most efficient");
console.log("  (fewer shipping charges, best per-unit from Surepack).");
console.log("");
console.log("  12×12×6 has 3.5mo of SP stock — can skip this round entirely.");
console.log("  12×12×12 has 494 Uline units (~60d) — start Surepack now.");
console.log("  30×15×15 has 120 Uline units (~31d) — start Surepack now.");
console.log("");

function pad(s: string|number, n: number): string { return String(s).padEnd(n); }
