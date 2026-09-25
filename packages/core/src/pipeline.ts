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
type ExtractedRole = { title: string; seniority: string; responsibilities: unknown; requirements: Array<{ text: string; kind: Requirement["kind"]; context?: string }> };

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 15;

/** Convert model-produced prose, bullet arrays, or keyed outlines into Appendix A's string fields. */
function toText(value: unknown, fallback: string): string {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const lines = value.map((item) => toText(item, "")).filter(Boolean);
    return lines.length ? lines.map((line) => `• ${line}`).join("\n") : fallback;
  }
  if (value && typeof value === "object") {
    const lines = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => {
        const text = toText(item, "");
        return text ? `${key.replace(/[_-]/g, " ")}: ${text}` : "";
      })
      .filter(Boolean);
    return lines.length ? lines.join("\n") : fallback;
  }
  return fallback;
}

function toDifficulty(value: unknown): 1 | 2 | 3 {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return number === 1 || number === 2 || number === 3 ? number : 2;
}

const QUESTION_CATEGORIES = ["technical", "behavioural", "system-design", "company-fit"] as const;
type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];

function toQuestionCategory(value: unknown, fallback: QuestionCategory): QuestionCategory {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase().replace(/[ _]+/g, "-");
  if ((QUESTION_CATEGORIES as readonly string[]).includes(normalized)) return normalized as QuestionCategory;
  if (/behavio|star|leadership|collaboration/.test(normalized)) return "behavioural";
  if (/system|architect|scalab|distributed/.test(normalized)) return "system-design";
  if (/company|culture|motivation|fit/.test(normalized)) return "company-fit";
  if (/technical|coding|engineering|experience/.test(normalized)) return "technical";
  return fallback;
}

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

function companyNameFromHost(hostname: string): string {
  const label = registrableCompanyDomain(hostname).split(".")[0] ?? hostname;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function registrableCompanyDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const labels = host.split(".");
  const multiLabelSuffixes = new Set(["co.in", "com.au", "co.uk", "co.nz", "com.br", "com.cn", "co.jp"]);
  const lastTwo = labels.slice(-2).join(".");
  return labels.length >= 3 && multiLabelSuffixes.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

async function searchDiscussion(company: string, companyHostname: string): Promise<string[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  const host = companyHostname.toLowerCase().replace(/^www\./, "");
  const companyDomain = registrableCompanyDomain(host);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query: `\"${company}\" software engineering interview experience interview process`,
          topic: "general",
          search_depth: "basic",
          max_results: 5,
          include_answer: false,
          include_raw_content: false,
          exclude_domains: [...new Set([host, companyDomain])],
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        const body = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
        return (body.results ?? [])
          .filter((item): item is { title?: string; url: string; content?: string } => typeof item.url === "string" && item.url.startsWith("https://"))
          .slice(0, 3)
          .map((item) => `${item.url}\n${item.title ?? "Public interview discussion"}\n${(item.content ?? "").slice(0, 5000)}`);
      }
      if (response.status !== 429 && response.status < 500) return [];
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5000)
        : 400 * 2 ** attempt;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, delay));
    } catch {
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
  }
  return [];
}

function ids(prefix: string, count: number): string[] { return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`); }

export async function generateKit(input: GenerateInput): Promise<Kit> {
  if (!input.jd.trim()) throw new Error("Job description is required");
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 60) throw new Error("Days must be an integer from 1 to 60");

  await announce(input, "extract_requirements", "started");
  const extracted = await chatJson<ExtractedRole>("Extract only explicit role details from the job description. Do not infer missing requirements. Return JSON with title, seniority, responsibilities, requirements [{text,kind,context}]. kind must be technical, behavioural, or domain. Include nearby wording in context for required/preferred priority classification.", { jd: input.jd });
  // LLMs sometimes return responsibility objects (for example {text: "..."})
  // despite the requested string array. Normalize each item to Appendix A's
  // required string representation before emitting progress or validating the kit.
  const responsibilities = Array.isArray(extracted.responsibilities)
    ? extracted.responsibilities.map((item) => toText(item, "")).filter(Boolean)
    : [];
  const requirements: Requirement[] = (extracted.requirements ?? []).map((requirement, index) => ({ id: `r${index + 1}`, text: requirement.text, kind: requirement.kind, priority: classifyPriority(requirement.text, requirement.context), meta: { source: "generated", pinned: false, version: 0 } }));
  await announce(input, "extract_requirements", "completed", undefined, { title: extracted.title, seniority: extracted.seniority, responsibilities, requirements });

  await announce(input, "discover_hiring_pages", "started");
  let pages: Page[] = [];
  try { pages = await crawl(input.company_url, input.allowLocalFetch ?? false); } catch { /* preserve partial research */ }
  await announce(input, "discover_hiring_pages", pages.length ? "completed" : "skipped", pages.length ? `${pages.length} page(s) fetched` : "Company pages could not be retrieved", { pages });

  await announce(input, "fetch_public_discussion", "started");
  const companyUrl = new URL(input.company_url);
  const companyName = companyNameFromHost(companyUrl.hostname);
  const discussion = await searchDiscussion(companyName, companyUrl.hostname);
  await announce(input, "fetch_public_discussion", discussion.length ? "completed" : "skipped", discussion.length ? `${discussion.length} public result(s)` : "No public discussion found (or search key not configured)", { discussion });

  await announce(input, "generate_company_brief", "started");
  const briefEvidence = pages.slice(0, 8).map((page) => ({ url: page.url, text: page.text.slice(0, 4000) }));
  const briefDiscussion = discussion.slice(0, 3).map((item) => item.slice(0, 3000));
  const brief = await chatJson<{ summary: unknown; what_they_do: unknown }>("Summarize only the supplied company evidence for the named company. State when research was unavailable. Never invent interview processes or company facts. Return JSON with summary and what_they_do as plain strings, not objects or arrays.", { company: companyName, pages: briefEvidence, discussion: briefDiscussion });
  await announce(input, "generate_company_brief", "completed", undefined, brief);

  await announce(input, "generate_questions", "started");
  const questions: Question[] = [];
  for (const requirement of requirements) {
    const designRequirement = /system design|architecture|architect|scalab|distributed|availability|reliability|microservice|design pattern|api design/i.test(requirement.text);
    const fallbackCategory: QuestionCategory = requirement.kind === "behavioural" ? "behavioural" : designRequirement ? "system-design" : "technical";
    const generated = await chatJson<{ questions: Array<{ prompt: unknown; answer_outline: unknown; difficulty: unknown; category?: unknown }> }>(`Create up to two strong interview questions specifically about this job requirement. Prefer practical, role-specific situations and tradeoffs over generic questions. Never ask candidates to repeat their education, degree, or resume unless the requirement explicitly asks for a credential. Do not invent experience or company facts. Classify each question with exactly one category: technical (coding, algorithms, tools), behavioural (specific past actions; use STAR), system-design (architecture, APIs, scale, reliability, tradeoffs), or company-fit (motivation, products, customers, values). Choose system-design for architecture or scalability requirements even when the role calls them technical. Return JSON {questions:[{prompt:string,answer_outline:string,difficulty:1|2|3,category:string}]}. prompt and answer_outline must be strings; answer_outline must be concise plain text, never an array or object.`, { jd: input.jd, requirement, companyEvidence: pages.slice(0, 4).map((page) => ({ url: page.url, text: page.text.slice(0, 1500) })), discussion: discussion.slice(0, 3).map((item) => item.slice(0, 1200)) });
    for (const item of generated.questions ?? []) {
      const modelCategory = toQuestionCategory(item.category, fallbackCategory);
      const questionCategory = designRequirement && modelCategory === "technical" ? "system-design" : modelCategory;
      questions.push({ id: `q${questions.length + 1}`, requirement_ids: [requirement.id], category: questionCategory, prompt: toText(item.prompt, `How would you approach ${requirement.text} in a real project?`), answer_outline: toText(item.answer_outline, `Explain your approach to ${requirement.text}, including key decisions and tradeoffs.`), difficulty: toDifficulty(item.difficulty), meta: { source: "generated", pinned: false, version: 0 } });
    }
  }
  const companyFit = await chatJson<{ questions: Array<{ prompt: unknown; answer_outline: unknown; difficulty: unknown }> }>("Create two concise company-fit interview questions tailored to this role and the supplied public company evidence. Ask about motivation, customer or product understanding, and how the candidate's strengths fit this role. Never invent facts. If company evidence is limited, ground the questions in the job description instead. Return JSON {questions:[{prompt:string,answer_outline:string,difficulty:1|2|3}]}; prompt and answer_outline must be plain strings.", { jd: input.jd, company: companyName, companyEvidence: pages.slice(0, 5).map((page) => ({ url: page.url, text: page.text.slice(0, 1800) })), discussion: discussion.slice(0, 3) });
  for (const item of companyFit.questions ?? []) questions.push({ id: `q${questions.length + 1}`, requirement_ids: [], category: "company-fit", prompt: toText(item.prompt, "What interests you about this company and this role?"), answer_outline: toText(item.answer_outline, "Connect a specific company or role detail to your skills and motivation."), difficulty: toDifficulty(item.difficulty), meta: { source: "generated", pinned: false, version: 0 } });
  await announce(input, "generate_questions", "completed", undefined, questions);

  const flashcards = await chatJson<{ flashcards: Array<{ front: string; back: string; requirement_id: string }> }>("Create one useful concise interview study flashcard per supplied requirement. Use only the provided requirements. Return JSON {flashcards:[{front,back,requirement_id}]}.", { requirements });
  const cards = (flashcards.flashcards ?? []).map((item, index) => ({ id: `f${index + 1}`, front: toText(item.front, "Review the relevant requirement."), back: toText(item.back, "Use the job description to guide your answer."), requirement_ids: requirements.some((req) => req.id === item.requirement_id) ? [item.requirement_id] : [], meta: { source: "generated", pinned: false, version: 0 } }));

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
      const generated = await chatJson<{ questions: Array<{ prompt: unknown; answer_outline: unknown; difficulty: unknown }> }>("Generate one interview question covering the specified missing requirement. Return JSON {questions:[{prompt:string,answer_outline:string,difficulty:number}]}. prompt and answer_outline must be plain strings, never arrays or objects. Use difficulty 1, 2, or 3.", { requirement, jd: input.jd });
      const category = requirement.kind === "behavioural" ? "behavioural" : requirement.kind === "technical" ? "technical" : "company-fit";
      for (const item of generated.questions ?? []) questions.push({ id: `q${questions.length + 1}`, requirement_ids: [id], category, prompt: toText(item.prompt, `How would you approach ${requirement.text}?`), answer_outline: toText(item.answer_outline, `Address the key aspects of ${requirement.text}.`), difficulty: toDifficulty(item.difficulty), meta: { source: "generated", pinned: false, version: 0 } });
    }
    coverage = checkCoverage(requirements, questions);
    coverage.passes = 2;
    const rebuilt = buildSchedule(requirements, questions, input.days);
    schedule.days = rebuilt.days.map((day) => ({ ...day, meta: { source: "generated", pinned: false, version: 0 } }));
    await announce(input, "fill_gaps", "completed", `${coverage.uncovered_requirement_ids.length} remaining gap(s)`, { questions, coverage, schedule });
  }
  const uncoveredMustHaveIds = coverage.uncovered_requirement_ids.filter((id) => requirements.find((requirement) => requirement.id === id)?.priority === "must");
  if (uncoveredMustHaveIds.length) {
    throw new Error(`Could not generate questions for must-have requirement(s): ${uncoveredMustHaveIds.join(", ")}. The incomplete kit was not returned.`);
  }
  await announce(input, "check_coverage", "completed", undefined, coverage);

  const kit = {
    source: { company: companyName, company_url: input.company_url, role: extracted.title ?? "", location: "", jd_chars: input.jd.length, researched_at: new Date().toISOString(), pages_used: pages.map((page) => page.url) },
    company_brief: { summary: toText(brief.summary, "Company research was unavailable."), what_they_do: toText(brief.what_they_do, "Insufficient public information was found."), sources: [...pages.map((page) => page.url), ...discussion.map((line) => line.split(" ")[0]!).filter((url) => url.startsWith("http"))], meta: { source: "generated", pinned: false, version: 0 } },
    role: { title: extracted.title ?? "", seniority: extracted.seniority ?? "", responsibilities, requirements },
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
  const parsedUrl = new URL(companyUrl);
  const companyName = companyNameFromHost(parsedUrl.hostname);
  const discussion = await searchDiscussion(companyName, parsedUrl.hostname);
  const brief = await chatJson<{ summary: unknown; what_they_do: unknown }>("Summarize only the supplied company evidence for the named company. State when research was unavailable. Never invent interview processes or company facts. Return JSON with summary and what_they_do as plain strings, not objects or arrays.", { company: companyName, pages: pages.map((page) => ({ url: page.url, text: page.text })), discussion });
  return { summary: toText(brief.summary, "Company research was unavailable."), what_they_do: toText(brief.what_they_do, "Insufficient public information was found."), sources: [...pages.map((page) => page.url), ...discussion.map((line) => line.split(" ")[0]!).filter((url) => url.startsWith("http"))], meta: { source: "generated", pinned: false, version: 0 } };
}

export async function regenerateCategoryQuestions(jd: string, companyUrl: string, requirements: Requirement[], category: Question["category"]): Promise<Question[]> {
  let evidence: Array<{ url: string; text: string }> = [];
  let discussion: string[] = [];
  try { evidence = (await crawl(companyUrl, false)).slice(0, 8).map((page) => ({ url: page.url, text: page.text.slice(0, 3500) })); } catch { /* the role description remains useful when company pages are unavailable */ }
  try { discussion = await searchDiscussion(companyNameFromHost(new URL(companyUrl).hostname), new URL(companyUrl).hostname); } catch { /* public discussion is optional */ }
  const technical = requirements.filter((item) => item.kind === "technical");
  const designTerms = /system design|architecture|architect|scalab|distributed|availability|reliability|microservice|design pattern|api design/i;
  const designRequirements = technical.filter((item) => designTerms.test(item.text));
  const matching = category === "behavioural"
    ? requirements.filter((item) => item.kind === "behavioural")
    : category === "system-design"
      ? (designRequirements.length ? designRequirements : technical)
      : category === "technical"
        ? technical.filter((item) => !designTerms.test(item.text)).concat(technical.some((item) => !designTerms.test(item.text)) ? [] : technical)
        : requirements;
  const anchors = matching.length ? matching.slice(0, 12) : requirements.slice(0, 8);
  const instructions: Record<QuestionCategory, string> = {
    technical: "Focus on concrete coding, algorithms, data structures, languages, tools, debugging, and implementation choices. Ask practical questions, not generic questions about education or resumes.",
    behavioural: "Ask for a specific past work or project example. Make the question suitable for a STAR response (situation, task, action, result), and tie it to collaboration, ownership, leadership, or role responsibilities.",
    "system-design": "Ask a concrete system design problem relevant to this role. The answer outline should mention clarifying requirements, APIs, data/storage, scaling, reliability, and tradeoffs as relevant. Do not ask a generic definition question.",
    "company-fit": "Ask role-specific motivation and company-fit questions grounded in the provided company evidence and job description. Include what the candidate understands about the product, customers, or impact. Do not invent company facts.",
  };
  const result = await chatJson<{ questions: Array<{ prompt: unknown; answer_outline: unknown; difficulty: unknown; requirement_id?: unknown }> }>(`Regenerate useful ${category} interview questions for the supplied job. ${instructions[category]} Questions must be distinct, specific to the role, and understandable without extra context. Return up to ${category === "company-fit" ? 4 : Math.max(1, Math.min(10, anchors.length))} questions in JSON {questions:[{prompt:string,answer_outline:string,difficulty:1|2|3,requirement_id:string|null}]}. prompt and answer_outline must be strings, never arrays or objects. For requirement_id, use only an id from the supplied requirements, or null for company-fit questions.`, { jd, company: new URL(companyUrl).hostname, requirements: anchors, companyEvidence: evidence, publicDiscussion: discussion.slice(0, 5) });
  const questions = (result.questions ?? []).map((item, index) => {
    const id = typeof item.requirement_id === "string" && anchors.some((requirement) => requirement.id === item.requirement_id) ? item.requirement_id : category === "company-fit" ? undefined : anchors[index % Math.max(1, anchors.length)]?.id;
    return { id: `qregen${index + 1}`, requirement_ids: id ? [id] : [], category, prompt: toText(item.prompt, `Describe how you would approach a ${category} challenge relevant to this role.`), answer_outline: toText(item.answer_outline, "Explain your reasoning, actions, tradeoffs, and the result you would aim for."), difficulty: toDifficulty(item.difficulty), meta: { source: "generated" as const, pinned: false, version: 0 } } satisfies Question;
  });
  if (!questions.length) throw new Error(`No ${category} questions were generated. Please try again.`);
  return questions;
}

export function inputHash(input: Pick<GenerateInput, "jd" | "company_url">): string {
  return createHash("sha256").update(`${input.jd.trim()}\n${input.company_url.trim()}`).digest("hex");
}
