import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { FinaleClient, type FinaleProductDetail } from "@/lib/finale/client";
import { assessPurchasingGroups, type AssessedPurchasingLine } from "@/lib/purchasing/assessment-service";
import {
  comparePurchasesGuidanceItem,
  type PurchasesGuidanceComparisonResult,
} from "@/lib/purchasing/purchases-guidance-comparison";
import type { PurchasesGuidanceBaseItem } from "@/lib/purchasing/purchases-guidance-parser";

function findEnvPath(startDir: string): string | null {
  let currentDir = startDir;

  while (true) {
    const candidate = path.join(currentDir, ".env.local");
    if (fs.existsSync(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

const resolvedEnvPath = findEnvPath(process.cwd());
if (resolvedEnvPath) {
  dotenv.config({ path: resolvedEnvPath });
}

type GuidanceDataset = Record<string, PurchasesGuidanceBaseItem[]>;

function parseArgs(argv: string[]) {
  let asJson = false;
  let vendorFilter: string | null = null;
  let inputPath: string | null = null;
  let daysBack = 90;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      asJson = true;
      continue;
    }

    if (arg === "--vendor") {
      vendorFilter = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--input") {
      inputPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--days-back") {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        daysBack = Math.round(parsed);
      }
      index += 1;
    }
  }

  return { asJson, vendorFilter, inputPath, daysBack };
}

function resolveInputPath(explicitInputPath: string | null): string {
  if (explicitInputPath) return path.resolve(process.cwd(), explicitInputPath);

  const livePath = path.resolve(process.cwd(), "purchases-data.json");
  if (fs.existsSync(livePath)) return livePath;

  return path.resolve(process.cwd(), "debug/purchases/purchases-data.sample.json");
}

function loadGuidanceDataset(filePath: string): GuidanceDataset {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as GuidanceDataset;
}

function buildAssessmentIndex(lines: AssessedPurchasingLine[]): Map<string, AssessedPurchasingLine> {
  return new Map(lines.map((line) => [line.item.productId.toUpperCase(), line]));
}

async function findFinaleProduct(
  finale: FinaleClient,
  cache: Map<string, FinaleProductDetail | null>,
  sku: string,
): Promise<FinaleProductDetail | null> {
  const normalizedSku = sku.toUpperCase();
  if (cache.has(normalizedSku)) return cache.get(normalizedSku) ?? null;

  const product = await finale.lookupProduct(normalizedSku);
  cache.set(normalizedSku, product);
  return product;
}

function renderTextSummary(results: PurchasesGuidanceComparisonResult[]) {
  const grouped = new Map<string, PurchasesGuidanceComparisonResult[]>();

  for (const result of results) {
    const current = grouped.get(result.vendorName) ?? [];
    current.push(result);
    grouped.set(result.vendorName, current);
  }

  for (const [vendorName, vendorResults] of grouped) {
    console.log(`\n=== ${vendorName} ===`);
    for (const result of vendorResults) {
      const decision = result.policyDecision ?? "none";
      console.log(
        `  [${result.classification}] ${result.sku} (${result.guidanceUrgency || "no urgency"}) -> ${decision}`,
      );
      console.log(`    ${result.explanation}`);
    }
  }
}

async function comparePurchasesGuidance() {
  const { asJson, vendorFilter, inputPath, daysBack } = parseArgs(process.argv.slice(2));
  const resolvedInputPath = resolveInputPath(inputPath);
  const guidanceDataset = loadGuidanceDataset(resolvedInputPath);

  const finale = new FinaleClient();
  const groups = await finale.getPurchasingIntelligence(daysBack);
  const assessment = assessPurchasingGroups(groups);
  const assessmentIndex = buildAssessmentIndex(assessment.groups.flatMap((group) => group.items));
  const finaleProductCache = new Map<string, FinaleProductDetail | null>();

  const comparisons: PurchasesGuidanceComparisonResult[] = [];

  for (const [vendorName, items] of Object.entries(guidanceDataset)) {
    if (vendorFilter && !vendorName.toLowerCase().includes(vendorFilter.toLowerCase())) {
      continue;
    }

    for (const item of items) {
      const assessedLine = assessmentIndex.get(item.sku.toUpperCase()) ?? null;
      const finaleProduct = assessedLine
        ? ({ productId: item.sku } as FinaleProductDetail)
        : await findFinaleProduct(finale, finaleProductCache, item.sku);

      comparisons.push(
        comparePurchasesGuidanceItem({
          vendorName,
          guidanceItem: item,
          assessedLine,
          finaleProduct,
        }),
      );
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ inputPath: resolvedInputPath, daysBack, comparisons }, null, 2));
    return;
  }

  console.log(
    `Loaded ${comparisons.length} guidance comparisons from ${path.basename(resolvedInputPath)} using ${daysBack} days of purchasing intelligence.`,
  );
  renderTextSummary(comparisons);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  comparePurchasesGuidance().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
