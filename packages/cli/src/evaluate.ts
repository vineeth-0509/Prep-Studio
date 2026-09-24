import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const rootEnv = resolve(process.cwd(), "../../.env");
dotenv.config({ path: process.env.ENV_FILE || (existsSync(rootEnv) ? rootEnv : resolve(process.cwd(), ".env")) });
import { readFile, writeFile } from "node:fs/promises";
import { generateKit, type Kit } from "@interview-prep/core";
import { z } from "zod";

const CasesSchema = z.array(z.object({ id: z.string(), jd: z.string(), company_url: z.string(), days: z.number().int() }));
type CaseResult = { id: string; status: "ok" | "failed"; kit: Kit | null; error: { code: string; message: string } | null };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const inputPath = arg("--input");
  const outputPath = arg("--output");
  if (!inputPath || !outputPath) throw new Error("Usage: npm run evaluate -- --input <cases.json> --output <kits.json>");
  const raw: unknown = JSON.parse(await readFile(inputPath, "utf8"));
  const cases = CasesSchema.parse(raw);
  const kits: CaseResult[] = [];
  const allowLocalFetch = process.env.ALLOW_LOCAL_FETCH === "true";
  for (const testCase of cases) {
    try {
      const kit = await generateKit({ jd: testCase.jd, company_url: testCase.company_url, days: testCase.days, allowLocalFetch });
      kits.push({ id: testCase.id, status: "ok", kit, error: null });
    } catch (error) {
      kits.push({ id: testCase.id, status: "failed", kit: null, error: { code: "GENERATION_FAILED", message: error instanceof Error ? error.message : "Unable to produce a kit." } });
    }
  }
  await writeFile(outputPath, `${JSON.stringify({ version: "1.0", generated_at: new Date().toISOString(), kits }, null, 2)}\n`, "utf8");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
