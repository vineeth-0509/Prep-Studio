import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const rootEnv = resolve(process.cwd(), "../../.env");
dotenv.config({ path: process.env.ENV_FILE || (existsSync(rootEnv) ? rootEnv : resolve(process.cwd(), ".env")) });
import { readFile, writeFile } from "node:fs/promises";
import { generateKit, type Kit } from "@interview-prep/core";
import { z } from "zod";

const CasesSchema = z.array(z.object({ id: z.string(), jd: z.string(), company_url: z.string(), days: z.number().int() }));

/** Serialize the internal editable kit using only Appendix A's public fields. */
function toAppendixAKit(kit: Kit) {
  return {
    source: {
      company: kit.source.company,
      company_url: kit.source.company_url,
      role: kit.source.role,
      location: kit.source.location,
      jd_chars: kit.source.jd_chars,
      researched_at: kit.source.researched_at,
      pages_used: kit.source.pages_used,
    },
    company_brief: {
      summary: kit.company_brief.summary,
      what_they_do: kit.company_brief.what_they_do,
      sources: kit.company_brief.sources,
    },
    role: {
      title: kit.role.title,
      seniority: kit.role.seniority,
      responsibilities: kit.role.responsibilities,
      requirements: kit.role.requirements.map(({ id, text, kind, priority }) => ({ id, text, kind, priority })),
    },
    questions: kit.questions.map(({ id, requirement_ids, category, prompt, answer_outline, difficulty }) => ({
      id, requirement_ids, category, prompt, answer_outline, difficulty,
    })),
    flashcards: kit.flashcards.map(({ id, front, back, requirement_ids }) => ({ id, front, back, requirement_ids })),
    schedule: {
      days_available: kit.schedule.days_available,
      days: kit.schedule.days.map(({ day, focus, question_ids, minutes }) => ({ day, focus, question_ids, minutes })),
    },
    coverage: {
      uncovered_requirement_ids: kit.coverage.uncovered_requirement_ids,
      passes: kit.coverage.passes,
    },
  };
}

type CaseResult = { id: string; status: "ok" | "failed"; kit: ReturnType<typeof toAppendixAKit> | null; error: { code: string; message: string } | null };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function filePaths(): { inputPath?: string; outputPath?: string } {
  const inputPath = arg("--input");
  const outputPath = arg("--output");
  if (inputPath && outputPath) return { inputPath, outputPath };

  // Some npm/PowerShell combinations consume the option names and forward
  // only their values. Preserve the documented command by accepting that
  // resulting pair of positional paths as a fallback.
  const positional = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  return { inputPath: inputPath ?? positional[0], outputPath: outputPath ?? positional[1] };
}

async function main() {
  const { inputPath, outputPath } = filePaths();
  if (!inputPath || !outputPath) throw new Error("Usage: npm run evaluate -- --input <cases.json> --output <kits.json>");
  const raw: unknown = JSON.parse(await readFile(inputPath, "utf8"));
  const cases = CasesSchema.parse(raw);
  const kits: CaseResult[] = [];
  const allowLocalFetch = process.env.ALLOW_LOCAL_FETCH === "true";
  for (const testCase of cases) {
    try {
      const kit = await generateKit({ jd: testCase.jd, company_url: testCase.company_url, days: testCase.days, allowLocalFetch });
      kits.push({ id: testCase.id, status: "ok", kit: toAppendixAKit(kit), error: null });
    } catch (error) {
      kits.push({ id: testCase.id, status: "failed", kit: null, error: { code: "GENERATION_FAILED", message: error instanceof Error ? error.message : "Unable to produce a kit." } });
    }
  }
  await writeFile(outputPath, `${JSON.stringify({ version: "1.0", generated_at: new Date().toISOString(), kits }, null, 2)}\n`, "utf8");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
