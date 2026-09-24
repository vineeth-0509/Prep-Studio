import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { load } from "cheerio";
import { checkCoverage } from "./coverage.js";
import { classifyPriority } from "./priority.js";
import { buildSchedule } from "./schedule.js";
import { validateKit, type Kit, type Question, type Requirement } from "./kit-schema.js";

export type PipelineStep = "extract_requirements" | "discover_hiring_pages" | "fetch_public_discussion" | "generate_company_brief" | "generate_questions" | "build_schedule" | "check_coverage" | "fill_gaps" | "validate_and_persist";
export type PipelineProgress = { step: PipelineStep; status: "started" | "completed" | "skipped"; detail?: string; partial?: unknown };
export type GenerateInput = { jd: string; company_url: string; days: number; allowLocalFetch?: boolean; onProgress?: (progress: PipelineProgress) => void | Promise<void> };

type Page = { url: string; text: string; links: Array<{ url: string; score: number }> };
type ExtractedRole = { title: string; seniority: string; responsibilities: string[]; requirements: Array<{ text: string; kind: Requirement["kind"]; context?: string }> };

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 15;

async function announce(input: GenerateInput, step: PipelineStep, status: PipelineProgress["status"], detail?: string, partial?: unknown) {
  await input.onProgress?.({ step, status, detail, partial });
}

async function chatJson<T>(system: string, data: unknown): Promise<T> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(data) }] }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) {
        const error = new Error(`OpenAI request failed (${response.status})`);
        if (response.status < 500 && response.status !== 429) throw error;
        lastError = error;
        const retryHeader = response.headers.get("retry-after");
        const retrySeconds = Number(retryHeader);
        const retryDateMs = retryHeader && Number.isNaN(retrySeconds) ? Date.parse(retryHeader) - Date.now() : 0;
        const retryMs = retrySeconds > 0 ? retrySeconds * 1000 : retryDateMs > 0 ? retryDateMs : Math.min(15_000, 700 * 2 ** attempt + Math.random() * 500);
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        continue;
      }
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenAI returned an empty response");
      return JSON.parse(content) as T;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, 700 * 2 ** attempt + Math.random() * 500)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("OpenAI request failed after retries");
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.")) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] === 169 && parts[1] === 254 || parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31 || parts[0] === 192 && parts[1] === 168 || parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127 || parts[0] === 198 && (parts[1] === 18 || parts[1] === 19) || parts[0]! >= 224;
}

async function assertPublicUrl(raw: string, allowLocalFetch: boolean): Promise<URL> {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Company URL must use HTTP or HTTPS");
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1";
  if (local && !allowLocalFetch) throw new Error("Local and loopback company URLs are not allowed");
  if (!allowLocalFetch) {
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("Private, loopback, or unresolved company hosts are not allowed");
  }
  return url;
}

async function getRobots(origin: string): Promise<string> {
  try {
    const response = await fetch(new URL("/robots.txt", origin), { signal: AbortSignal.timeout(5000) });
    return response.ok ? (await response.text()).slice(0, 100_000) : "";
  } catch { return ""; }
}

function allowedByRobots(robots: string, path: string): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let group: { agents: string[]; rules: Array<{ allow: boolean; path: string }> } | undefined;
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]!.trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (!group || group.rules.length) { group = { agents: [], rules: [] }; groups.push(group); }
      group.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && value && group) {
      group.rules.push({ allow: key === "allow", path: value });
    }
  }
  const applicable = groups.filter((candidate) => candidate.agents.includes("*") || candidate.agents.includes("aiinterviewprepkit"));
  const rules = applicable.flatMap((candidate) => candidate.rules).filter((rule) => {
    const pattern = rule.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
    try { return new RegExp(`^${pattern}`).test(path); } catch { return path.startsWith(rule.path); }
  }).sort((a, b) => b.path.replace(/[*$]/g, "").length - a.path.replace(/[*$]/g, "").length || Number(b.allow) - Number(a.allow));
  return rules[0]?.allow ?? true;
}

async function fetchPage(url: URL, allowLocalFetch: boolean): Promise<Page | null> {
  for (let attempt = 0; attempt < 3; attempt++) try {
    let target = url;
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      await assertPublicUrl(target.href, allowLocalFetch);
      response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "User-Agent": "AIInterviewPrepKit/1.0" } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location || redirects >= 4) return null;
      target = new URL(location, target);
    }
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PAGE_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const html = new TextDecoder().decode(Buffer.concat(chunks));
    const $ = load(html);
    $("script, style, nav, footer, header, noscript, svg, iframe, form").remove();
    const text = ($("main").text() || $("body").text()).replace(/\s+/g, " ").trim().slice(0, 50_000);
    const links: Page["links"] = [];
    $("a[href]").each((_index, element) => {
      try {
        const next = new URL($(element).attr("href")!, url);
        if (next.hostname !== url.hostname || !["http:", "https:"].includes(next.protocol)) return;
        const cue = `${next.pathname} ${$(element).text()}`.toLowerCase();
        const score = (cue.match(/careers?|jobs?|hiring|interview|life-at|engineering|handbook|about/g) ?? []).length;
        links.push({ url: next.href.split("#")[0]!, score });
      } catch { /* skip malformed href */ }
    });
    return { url: response.url || target.href, text, links };
  } catch {
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
  }
  return null;
}

async function crawl(rawUrl: string, allowLocalFetch: boolean): Promise<Page[]> {
  const start = await assertPublicUrl(rawUrl, allowLocalFetch);
  const robots = await getRobots(start.origin);
  const queue: Array<{ url: URL; depth: number }> = [{ url: start, depth: 0 }];
  const visited = new Set<string>();
  const pages: Page[] = [];
  while (queue.length && pages.length < MAX_PAGES) {
    queue.sort((a, b) => b.depth - a.depth ? a.depth - b.depth : 0);
    const current = queue.shift()!;
    const canonical = current.url.href;
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    if (!allowedByRobots(robots, current.url.pathname)) continue;
    const page = await fetchPage(current.url, allowLocalFetch);
    if (!page) continue;
    pages.push(page);
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (current.depth < 2) {
      page.links.sort((a, b) => b.score - a.score);
      for (const link of page.links) if (!visited.has(link.url)) queue.push({ url: new URL(link.url), depth: current.depth + 1 });
    }
  }
  return pages;
}

async function searchDiscussion(company: string): Promise<string[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return [];
  try {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", `"${company}" interview process engineering interview`);
    url.searchParams.set("count", "5");
    const response = await fetch(url, { headers: { "X-Subscription-Token": key, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return [];
    const body = await response.json() as { web?: { results?: Array<{ url?: string; description?: string }> } };
    const results = (body.web?.results ?? []).filter((item): item is { url: string; description?: string } => Boolean(item.url)).slice(0, 3);
    const fetched: string[] = [];
    for (const result of results) {
      try {
        await assertPublicUrl(result.url, false);
        const page = await fetchPage(new URL(result.url), false);
        fetched.push(`${result.url} ${page?.text.slice(0, 6000) || result.description || ""}`);
      } catch { fetched.push(`${result.url} ${result.description || ""}`); }
    }
    return fetched;
  } catch { return []; }
}

function ids(prefix: string, count: number): string[] { return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`); }

export async function generateKit(input: GenerateInput): Promise<Kit> {
  if (!input.jd.trim()) throw new Error("Job description is required");
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 60) throw new Error("Days must be an integer from 1 to 60");

  await announce(input, "extract_requirements", "started");
  const extracted = await chatJson<ExtractedRole>("Extract only explicit role details from the job description. Do not infer missing requirements. Return JSON with title, seniority, responsibilities, requirements [{text,kind,context}]. kind must be technical, behavioural, or domain. Include nearby wording in context for required/preferred priority classification.", { jd: input.jd });
  const requirements: Requirement[] = (extracted.requirements ?? []).map((requirement, index) => ({ id: `r${index + 1}`, text: requirement.text, kind: requirement.kind, priority: classifyPriority(requirement.text, requirement.context), meta: { source: "generated", pinned: false, version: 0 } }));
  await announce(input, "extract_requirements", "completed", undefined, { title: extracted.title, seniority: extracted.seniority, responsibilities: extracted.responsibilities, requirements });

  await announce(input, "discover_hiring_pages", "started");
  let pages: Page[] = [];
  try { pages = await crawl(input.company_url, input.allowLocalFetch ?? false); } catch { /* preserve partial research */ }
  await announce(input, "discover_hiring_pages", pages.length ? "completed" : "skipped", pages.length ? `${pages.length} page(s) fetched` : "Company pages could not be retrieved", { pages });

  await announce(input, "fetch_public_discussion", "started");
  const discussion = await searchDiscussion(pages[0]?.url ?? new URL(input.company_url).hostname);
  await announce(input, "fetch_public_discussion", discussion.length ? "completed" : "skipped", discussion.length ? `${discussion.length} public result(s)` : "No public discussion found (or search key not configured)", { discussion });

  await announce(input, "generate_company_brief", "started");
  const briefEvidence = pages.slice(0, 8).map((page) => ({ url: page.url, text: page.text.slice(0, 4000) }));
  const briefDiscussion = discussion.slice(0, 3).map((item) => item.slice(0, 3000));
  const brief = await chatJson<{ summary: string; what_they_do: string }>("Summarize only the supplied company evidence. State when research was unavailable. Never invent interview processes or company facts. Return JSON with summary and what_they_do.", { pages: briefEvidence, discussion: briefDiscussion });
  await announce(input, "generate_company_brief", "completed", undefined, brief);

  await announce(input, "generate_questions", "started");
  const questions: Question[] = [];
  for (const requirement of requirements) {
    const category = requirement.kind === "behavioural" ? "behavioural" : requirement.kind === "technical" ? "technical" : "company-fit";
    const generated = await chatJson<{ questions: Array<{ prompt: string; answer_outline: string; difficulty: 1 | 2 | 3; category?: Question["category"] }> }>(`Generate up to two concise interview questions for this one requirement, with an answer outline. Use a distinct ${category} interview framing. Return JSON {questions:[{prompt,answer_outline,difficulty,category}]}. Use difficulty 1, 2, or 3.`, { jd: input.jd, requirement, companyEvidence: pages.slice(0, 4).map((page) => page.text.slice(0, 1500)), discussion: discussion.slice(0, 3).map((item) => item.slice(0, 1200)) });
    for (const item of generated.questions ?? []) questions.push({ id: `q${questions.length + 1}`, requirement_ids: [requirement.id], category: item.category ?? category, prompt: item.prompt, answer_outline: item.answer_outline, difficulty: item.difficulty, meta: { source: "generated", pinned: false, version: 0 } });
  }
  await announce(input, "generate_questions", "completed", undefined, questions);

  const flashcards = await chatJson<{ flashcards: Array<{ front: string; back: string; requirement_id: string }> }>("Create one useful concise interview study flashcard per supplied requirement. Use only the provided requirements. Return JSON {flashcards:[{front,back,requirement_id}]}.", { requirements });
  const cards = (flashcards.flashcards ?? []).map((item, index) => ({ id: `f${index + 1}`, front: item.front, back: item.back, requirement_ids: requirements.some((req) => req.id === item.requirement_id) ? [item.requirement_id] : [], meta: { source: "generated", pinned: false, version: 0 } }));

  await announce(input, "build_schedule", "started");
  const schedule = buildSchedule(requirements, questions, input.days);
  schedule.days = schedule.days.map((day) => ({ ...day, meta: { source: "generated", pinned: false, version: 0 } }));
  await announce(input, "build_schedule", "completed", undefined, schedule);

  await announce(input, "check_coverage", "started");
  let coverage = checkCoverage(requirements, questions);
  if (coverage.uncovered_requirement_ids.length) {
    await announce(input, "fill_gaps", "started");
    for (const id of coverage.uncovered_requirement_ids) {
      const requirement = requirements.find((candidate) => candidate.id === id)!;
      const generated = await chatJson<{ questions: Array<{ prompt: string; answer_outline: string; difficulty: 1 | 2 | 3 }> }>("Generate one interview question covering the specified missing requirement. Return JSON {questions:[{prompt,answer_outline,difficulty}]}.", { requirement, jd: input.jd });
      for (const item of generated.questions ?? []) questions.push({ id: `q${questions.length + 1}`, requirement_ids: [id], category: requirement.kind === "behavioural" ? "behavioural" : "technical", prompt: item.prompt, answer_outline: item.answer_outline, difficulty: item.difficulty, meta: { source: "generated", pinned: false, version: 0 } });
    }
    coverage = checkCoverage(requirements, questions);
    coverage.passes = 2;
    const rebuilt = buildSchedule(requirements, questions, input.days);
    schedule.days = rebuilt.days.map((day) => ({ ...day, meta: { source: "generated", pinned: false, version: 0 } }));
    await announce(input, "fill_gaps", "completed", `${coverage.uncovered_requirement_ids.length} remaining gap(s)`, { questions, coverage, schedule });
  }
  await announce(input, "check_coverage", "completed", undefined, coverage);

  const companyUrl = new URL(input.company_url);
  const kit = {
    source: { company: companyUrl.hostname, company_url: input.company_url, role: extracted.title ?? "", location: "", jd_chars: input.jd.length, researched_at: new Date().toISOString(), pages_used: pages.map((page) => page.url) },
    company_brief: { summary: brief.summary ?? "Company research was unavailable.", what_they_do: brief.what_they_do ?? "Insufficient public information was found.", sources: [...pages.map((page) => page.url), ...discussion.map((line) => line.split(" ")[0]!).filter((url) => url.startsWith("http"))], meta: { source: "generated", pinned: false, version: 0 } },
    role: { title: extracted.title ?? "", seniority: extracted.seniority ?? "", responsibilities: extracted.responsibilities ?? [], requirements },
    questions, flashcards: cards, schedule, coverage,
  };
  await announce(input, "validate_and_persist", "started");
  const validated = validateKit(kit);
  await announce(input, "validate_and_persist", "completed", undefined, validated);
  return validated;
}

export async function regenerateCompanyBrief(companyUrl: string, allowLocalFetch = false): Promise<Kit["company_brief"]> {
  let pages: Page[] = [];
  try { pages = await crawl(companyUrl, allowLocalFetch); } catch { /* return an honest limited brief */ }
  const discussion = await searchDiscussion(pages[0]?.url ?? new URL(companyUrl).hostname);
  const brief = await chatJson<{ summary: string; what_they_do: string }>("Summarize only the supplied company evidence. State when research was unavailable. Never invent interview processes or company facts. Return JSON with summary and what_they_do.", { pages: pages.map((page) => ({ url: page.url, text: page.text })), discussion });
  return { summary: brief.summary ?? "Company research was unavailable.", what_they_do: brief.what_they_do ?? "Insufficient public information was found.", sources: [...pages.map((page) => page.url), ...discussion.map((line) => line.split(" ")[0]!).filter((url) => url.startsWith("http"))], meta: { source: "generated", pinned: false, version: 0 } };
}

export async function regenerateCategoryQuestions(jd: string, companyUrl: string, requirements: Requirement[], category: Question["category"]): Promise<Question[]> {
  let evidence: string[] = [];
  let discussion: string[] = [];
  try { evidence = (await crawl(companyUrl, false)).map((page) => page.text.slice(0, 5000)); } catch { /* limited research is valid */ }
  try { discussion = await searchDiscussion(new URL(companyUrl).hostname); } catch { /* no discussion is valid */ }
  const matching = category === "behavioural" ? requirements.filter((item) => item.kind === "behavioural") : category === "company-fit" || category === "system-design" ? requirements : requirements.filter((item) => item.kind === "technical");
  const questions: Question[] = [];
  for (const requirement of matching) {
    const result = await chatJson<{ questions: Array<{ prompt: string; answer_outline: string; difficulty: 1 | 2 | 3 }> }>(`Generate up to two ${category} interview questions for the specified requirement. Use real hiring-process evidence if it indicates this round. Return JSON {questions:[{prompt,answer_outline,difficulty}]}. Only cover this requirement.`, { jd, requirement, companyEvidence: evidence, discussion });
    for (const item of result.questions ?? []) questions.push({ id: `qregen${questions.length + 1}`, requirement_ids: [requirement.id], category, prompt: item.prompt, answer_outline: item.answer_outline, difficulty: item.difficulty, meta: { source: "generated", pinned: false, version: 0 } });
  }
  return questions;
}

export function inputHash(input: Pick<GenerateInput, "jd" | "company_url">): string {
  return createHash("sha256").update(`${input.jd.trim()}\n${input.company_url.trim()}`).digest("hex");
}
