# AI Interview Prep Kit

A full-stack app that turns a pasted job description, company website, and interview date into an editable preparation kit. It researches company pages, extracts requirements, creates practice questions and flashcards, checks coverage in code, and allocates study work across the available days.

## Stack and architecture

- **Web:** Next.js App Router, TypeScript, Tailwind CSS, Framer Motion
- **API:** Node.js, Express, TypeScript
- **Persistence:** MongoDB with Mongoose
- **Generation:** OpenAI Chat Completions API, default model `gpt-4o-mini`
- **Validation:** Zod
- **Research:** bounded HTML crawl with robots.txt checks; optional Brave Search API for public interview discussion

This is an npm workspaces monorepo. `packages/core` owns the kit contract, deterministic rules, retrieval helpers, and generation pipeline. Both the Express API and `packages/cli` import this package directly. The batch path therefore runs the same `generateKit` implementation as web requests instead of maintaining a second pipeline.

## Local setup

Install Node.js 20+ and MongoDB, then from the repository root:

```sh
npm install
```

Copy `.env.example` to `.env` and set `OPENAI_API_KEY`, `JWT_SECRET`, and `MONGODB_URI`. `BRAVE_SEARCH_API_KEY` is optional; without it the app records that no public discussion was found. The browser API address defaults to `http://localhost:4000/api`.

Run the API and web app in separate terminals:

```sh
npm run dev:server
npm run dev
```

The web app is at `http://localhost:3000`, the API at `http://localhost:4000/api`, and `GET /api/health` is the backend health check.

## Batch entry point

The required command is:

```sh
npm run evaluate -- --input cases.json --output kits.json
```

The input is an array of `{ "id": string, "jd": string, "company_url": string, "days": number }`. Output is `{ "version": "1.0", "generated_at": ISO timestamp, "kits": [...] }`, where every case gets either `{id,status:"ok",kit,error:null}` or `{id,status:"failed",kit:null,error:{code,message}}`. The CLI continues after a failed case and uses the shared core pipeline. For local HTTP fixtures only, set `ALLOW_LOCAL_FETCH=true` in the environment before running the command; the web API never enables this exception.

## Kit contract and pipeline

`packages/core/src/kit-schema.ts` implements Appendix A without renaming its required fields. Zod validates integer `jd_chars`, `minutes`, and `difficulty`; allowed requirement/question enums; and that every question or flashcard requirement reference and every scheduled question reference resolves. Unknown additive fields pass through so edit metadata is retained.

The pipeline is deliberately staged and reports progress:

1. Extract requirements, role title, seniority, and responsibilities from the pasted JD only. A deterministic phrase classifier marks explicit required language `must`, explicit preferred/bonus language `nice`, and ambiguity `nice`.
2. Check robots.txt and crawl same-host links using breadth-first traversal, relevance ranking, depth two, a 15-page cap, and a 2 MB per-page cap. Failed pages are skipped.
3. Search optional public discussion results and include them as evidence; if the search key is absent or returns nothing, the brief says so rather than inventing a process.
4. Generate the company brief from retrieved text and discussion snippets.
5. Generate questions per requirement with a category-specific prompt. Calls are sequential, which caps model concurrency at one and avoids token bursts. Hiring evidence is included in question generation.
6. Allocate questions to the requested number of days in deterministic code.
7. Check coverage in code; generate a gap-only second pass when needed, then check once more. The pass count is recorded. The pipeline ships remaining gaps honestly after the second pass.
8. Validate the complete kit against Appendix A before persistence or CLI output.

OpenAI requests retry transient failures and HTTP 429 responses up to five times with exponential delay and jitter, respecting `Retry-After`. Company HTML requests retry up to three times. `inputHash` deduplicates a user's repeated JD and company URL; a running request is reused and a failed request can be retried.

## Deterministic schedule

Questions sort by must-have priority, then difficulty, then stable ID. Difficulty estimates are 10, 15, and 25 minutes. Questions are assigned to the least-loaded day with a small early-day weighting. The output always has exactly `days_available` days; empty days in a long schedule become must-have review days, or the top-ranked topic when there are no must-haves. A one-day schedule includes all questions and compresses the work into that day. Every day's focus is built from its dominant question category.

Coverage is a set comparison between requirement IDs and all linked question requirement IDs. Model output never decides whether coverage passes.

## Editing and regeneration

Requirements, questions, flashcards, the company brief, and schedule days carry additive metadata: `source` (`generated`, `user_edited`, or `user_created`), `pinned`, and `version`. Content edits pin an item and increment its version; hand-added questions/cards are pinned at creation. Reordering and moving a question between categories leave its metadata unchanged. Deletion removes the item and its schedule references. Regeneration has dedicated brief, question-category, and schedule operations; pinned items survive, eligible generated content is replaced, and question regeneration rechecks coverage. The browser updates optimistically and restores the prior state if a save fails.

Practice mode reveals cards one at a time, records confidence from 1 to 5, and sorts the next review by `(must ? 2 : 1) × difficulty × (6 − confidence)`, so low-confidence, difficult, must-have topics surface first. The Weak Spots report groups that same deterministic score by requirement so someone preparing can see what to revisit first, instead of treating every forgotten card as equally urgent.

## Security and failure handling

Passwords are bcrypt-hashed. A signed JWT lives in an httpOnly cookie; production requires `JWT_SECRET` and uses a secure cookie. Kit queries always include the authenticated owner ID. Incoming kit changes are Zod-validated, auth and generation routes are rate-limited, CORS is restricted to `WEB_ORIGIN`, and server errors return structured messages. External fetches require HTTP(S), check DNS-resolved addresses against private/loopback ranges, recheck redirects, accept HTML only, and cap response size. Fetched text and the JD are sent as data in user messages, while system prompts explicitly prohibit following instructions found inside that data.

A failed company fetch is a skipped source, not a fatal pipeline failure. A thin JD produces a thin kit. No public discussion produces an honest empty-research note. A case is `failed` only when no kit can be generated at all.

## Tests and commands

```sh
npm run typecheck
npm test
npm run build
```

The core tests cover exact day counts and long/short schedule edges, requirement coverage, priority classification, and Appendix A structure and references.

## Deployment

Deploy `packages/web` and `packages/server` as separate services with the same MongoDB database. Set the documented environment variables in each host's secret manager; set `WEB_ORIGIN` to the deployed frontend origin and `NEXT_PUBLIC_API_URL` to the deployed API's `/api` URL. Never enable `ALLOW_LOCAL_FETCH` on the web service. The public deployment itself requires hosting and database credentials, which are not part of this repository.

## Known limitations

- The crawler handles static HTML and does not execute client-side JavaScript.
- Public discussion search requires an optional Brave Search API key. Up to three returned pages are fetched and cleaned, with provider snippets as a fallback.
- The crawler has bounded retries and page limits. Completed pipeline-step results and progress are stored; if the server restarts during a run, it safely replays that case from the beginning.
- The batch CSV upload in the web interface expects a header row with `id,jd,company_url,days`; the assessment CLI contract is JSON as specified in Section 9 and Appendix B.
