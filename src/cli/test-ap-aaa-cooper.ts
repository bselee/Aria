import { readFileSync } from "fs";
import { join } from "path";

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function main() {
    const targetPath = join(process.cwd(), "src", "cli", "reconcile-aaa.ts");
    const source = readFileSync(targetPath, "utf8");

    assert(
        source.includes("splitAAACooperStatementAttachments"),
        "reconcile-aaa.ts should use the shared AAA Cooper splitter",
    );
    assert(
        !source.includes("extractPerPage"),
        "reconcile-aaa.ts should not use extractPerPage directly anymore",
    );
    assert(
        !source.includes("unifiedTextGeneration"),
        "reconcile-aaa.ts should not use inline page LLM classification anymore",
    );

    console.log("AAA Cooper CLI is using the shared OCR-first splitter.");
}

main();
