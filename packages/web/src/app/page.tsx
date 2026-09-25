"use client";

import { motion, useReducedMotion } from "framer-motion";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { buildSchedule, checkCoverage, type Kit } from "@interview-prep/core/browser";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api";
const pipelineSteps = ["extract_requirements", "discover_hiring_pages", "fetch_public_discussion", "generate_company_brief", "generate_questions", "build_schedule", "check_coverage", "fill_gaps", "validate_and_persist"];
type User = { id: string; email: string };
type KitRecord = { id: string; status: string; current_step?: string; steps_completed?: string[]; kit?: Kit; error?: { message: string }; days?: number; createdAt?: string };
type QuestionCategory = Kit["questions"][number]["category"];
type QuestionFilter = "all" | QuestionCategory;
type RegenerationSection = "company_brief" | "schedule" | "question_category";
type StudyProgress = Record<number, string[]>;
const interviewDayChecklist = [
  { id: "company", label: "Review the company brief and research sources" },
  { id: "requirements", label: "Review the role’s most important requirements" },
  { id: "examples", label: "Choose two examples that show your impact" },
  { id: "questions", label: "Pick questions you want to ask the interviewer" },
  { id: "setup", label: "Check your interview time, setup, and materials" },
];
const editedMeta = (item: object) => {
  const previous = ((item as { meta?: unknown }).meta ?? {}) as { version?: number };
  return { source: "user_edited" as const, pinned: true, version: (previous.version ?? 0) + 1 };
};

function daysUntilInterview(createdAt?: string, days?: number): number | null {
  if (!createdAt || !Number.isInteger(days) || !days || days < 1) return null;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  const today = new Date();
  const interviewDate = new Date(created.getFullYear(), created.getMonth(), created.getDate() + days);
  const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.round((interviewDate.getTime() - todayDate.getTime()) / 86_400_000));
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...init.headers } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/auth/me" && typeof window !== "undefined") window.location.reload();
  if (!response.ok) throw new Error(data.message || "Request failed");
  return data as T;
}

function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [[]];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted && char === '"' && text[index + 1] === '"') { field += '"'; index++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { rows.at(-1)!.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && text[index + 1] === "\n") index++; rows.at(-1)!.push(field); field = ""; if (rows.at(-1)!.some((value) => value.trim())) rows.push([]); }
    else field += char;
  }
  rows.at(-1)!.push(field);
  const headers = (rows.shift() ?? []).map((value) => value.trim().toLowerCase());
  return rows.filter((row) => row.some((value) => value.trim())).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

function LandingPage({ onSignIn }: { onSignIn: () => void }) {
  const features = [
    { number: "01", title: "Grounded company research", description: "Understand what the company does and see the public sources behind your brief." },
    { number: "02", title: "Practice for your role", description: "Turn a job description into focused technical, behavioural, system design, and company-fit questions." },
    { number: "03", title: "A plan you can follow", description: "Study with a day-by-day schedule, answer guides, flashcards, and confidence-based weak spots." },
  ];

  return <main id="top" className="min-h-screen overflow-hidden bg-white text-slate-950">
    <header className="border-b border-slate-200/80 bg-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
        <a href="#top" className="text-lg font-semibold tracking-tight">Prep<span className="text-indigo-600">Studio</span></a>
        <nav aria-label="Main navigation" className="hidden items-center gap-8 text-sm text-slate-600 md:flex">
          <a href="#features" className="hover:text-slate-950">Features</a>
          <a href="#how-it-works" className="hover:text-slate-950">How it works</a>
          <a href="#practice" className="hover:text-slate-950">Practice tools</a>
        </nav>
        <button type="button" onClick={onSignIn} className="rounded-full bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700">Sign in</button>
      </div>
    </header>

    <section className="relative isolate border-b border-slate-100">
      <div aria-hidden="true" className="absolute -right-40 top-16 -z-10 h-96 w-96 rounded-full bg-indigo-100/70 blur-3xl" />
      <div className="mx-auto grid max-w-7xl items-center gap-14 px-5 py-16 sm:px-8 sm:py-24 lg:grid-cols-[1fr_.9fr] lg:gap-16">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700"><span className="h-1.5 w-1.5 rounded-full bg-indigo-500" /> Interview preparation, tailored to you</p>
          <h1 className="mt-6 max-w-3xl text-5xl font-semibold leading-[1.06] tracking-[-.045em] sm:text-6xl lg:text-7xl">Walk into your next interview <span className="text-indigo-600">ready.</span></h1>
          <p className="mt-6 max-w-xl text-base leading-7 text-slate-600 sm:text-lg sm:leading-8">PrepStudio turns a job description and company website into a practical interview study plan, so you know what to learn, what to practice, and where to focus.</p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <button type="button" onClick={onSignIn} className="rounded-xl bg-indigo-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/20 transition hover:-translate-y-0.5 hover:bg-indigo-700">Get started <span aria-hidden="true">→</span></button>
            <a href="#how-it-works" className="rounded-xl px-4 py-3.5 text-sm font-semibold text-slate-700 hover:bg-slate-100">See how it works</a>
          </div>
          <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-500"><span>✓ Role-specific practice</span><span>✓ Clear daily plan</span><span>✓ Your progress stays saved</span></div>
        </div>

        <div aria-label="Preview of a PrepStudio interview plan" className="relative mx-auto w-full max-w-xl">
          <div className="absolute -inset-4 -rotate-3 rounded-[2rem] bg-indigo-100/70" />
          <div className="relative rotate-1 rounded-[1.6rem] border border-slate-200 bg-white p-5 shadow-2xl shadow-slate-900/10 sm:p-7">
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-5"><div><p className="text-[10px] font-bold uppercase tracking-[.2em] text-indigo-600">Your interview plan</p><h2 className="mt-2 text-xl font-semibold">Software Engineer</h2><p className="mt-1 text-sm text-slate-500">5 days to prepare</p></div><span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">Ready to practice</span></div>
            <div className="mt-5 grid grid-cols-5 gap-2" aria-hidden="true">{[1, 2, 3, 4, 5].map((day) => <div key={day} className={`rounded-lg border p-2 text-center ${day === 1 ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-slate-50 text-slate-500"}`}><span className="block text-[9px] uppercase">Day</span><span className="text-sm font-semibold">{day}</span></div>)}</div>
            <div className="mt-5 rounded-xl bg-slate-50 p-4"><div className="flex items-center justify-between"><p className="text-xs font-semibold text-slate-700">Technical practice</p><span className="text-[10px] text-slate-400">25 min</span></div><div className="mt-3 space-y-2"><p className="rounded-lg border border-slate-100 bg-white p-3 text-xs leading-5 text-slate-700">How would you design a service that stays reliable as traffic grows?</p><div className="flex gap-2"><span className="rounded-full bg-indigo-50 px-2.5 py-1 text-[10px] text-indigo-700">System design</span><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] text-emerald-700">Answer guide included</span></div></div></div>
            <div className="mt-4 flex items-center gap-3 rounded-xl border border-slate-100 p-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-amber-50 text-amber-700">✦</span><div className="min-w-0 flex-1"><p className="text-xs font-semibold">Flashcard review</p><p className="mt-0.5 truncate text-[10px] text-slate-500">Focus on the topics you rated least confident</p></div><div className="flex gap-1" aria-hidden="true"><span className="h-1.5 w-5 rounded-full bg-indigo-600"/><span className="h-1.5 w-5 rounded-full bg-indigo-200"/><span className="h-1.5 w-5 rounded-full bg-indigo-200"/></div></div>
          </div>
          <div className="absolute -bottom-7 -left-7 hidden items-center gap-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-xl sm:flex"><span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-700">✓</span><div><p className="text-xs font-semibold">Built around your role</p><p className="mt-1 text-[10px] text-slate-500">Questions · schedule · progress</p></div></div>
        </div>
      </div>
    </section>

    <section id="how-it-works" className="mx-auto max-w-7xl px-5 py-16 sm:px-8 sm:py-20">
      <div className="max-w-2xl"><p className="text-xs font-bold uppercase tracking-[.2em] text-indigo-600">A clearer way to prepare</p><h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">From job description to interview-ready.</h2><p className="mt-4 leading-7 text-slate-600">Start with the role you want. PrepStudio organizes the research and practice into one workspace you can return to every day.</p></div>
      <div id="features" className="mt-10 grid gap-4 md:grid-cols-3">{features.map((feature) => <article key={feature.number} className="rounded-2xl border border-slate-200 bg-white p-6 transition hover:-translate-y-1 hover:shadow-lg"><p className="text-xs font-semibold text-indigo-600">{feature.number}</p><h3 className="mt-5 text-lg font-semibold">{feature.title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{feature.description}</p></article>)}</div>
    </section>

    <section id="practice" className="bg-slate-950 text-white"><div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 px-5 py-12 sm:px-8 md:flex-row md:items-center"><div><p className="text-xs font-bold uppercase tracking-[.2em] text-indigo-300">Make your next practice session count</p><h2 className="mt-2 text-2xl font-semibold sm:text-3xl">Your next interview starts with a plan.</h2></div><button type="button" onClick={onSignIn} className="rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-indigo-100">Sign in to PrepStudio <span aria-hidden="true">→</span></button></div></section>
    <footer className="border-t border-slate-200 px-5 py-6 text-center text-xs text-slate-500">PrepStudio · Make interview preparation more focused.</footer>
  </main>;
}

type BuilderProps = {
  jd: string;
  onJdChange: (value: string) => void;
  companyUrl: string;
  onCompanyUrlChange: (value: string) => void;
  days: number;
  onDaysChange: (value: number) => void;
  busy: boolean;
  message: string;
  batchMessage: string;
  onSubmit: (event: FormEvent) => void;
  onBatchFile: (file?: File) => void;
  compact?: boolean;
};

function NewKitBuilder({ jd, onJdChange, companyUrl, onCompanyUrlChange, days, onDaysChange, busy, message, batchMessage, onSubmit, onBatchFile, compact = false }: BuilderProps) {
  return <div className={compact ? "space-y-4" : "mx-auto w-full max-w-2xl space-y-4"}>
    <form onSubmit={onSubmit} className={`rounded-2xl bg-slate-950 text-white ${compact ? "p-5" : "p-6 shadow-xl shadow-slate-900/10 sm:p-8"}`}>
      <p className="text-xs font-bold uppercase tracking-widest text-indigo-300">New preparation kit</p>
      {!compact && <p className="mt-2 text-sm leading-6 text-slate-300">Paste the job description and company website. We’ll build a role-specific plan you can edit and revisit.</p>}
      <label className="mt-4 block text-sm font-medium">Job description<textarea required rows={compact ? 5 : 7} value={jd} onChange={(event) => onJdChange(event.target.value)} placeholder="Paste the role description here…" className="mt-2 w-full resize-y rounded-xl border border-white/15 bg-white/10 p-3 text-sm leading-6 text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-indigo-400" /></label>
      <label className="mt-3 block text-sm font-medium">Company website<input required type="url" value={companyUrl} onChange={(event) => onCompanyUrlChange(event.target.value)} placeholder="https://company.com" className="mt-2 w-full rounded-xl border border-white/15 bg-white/10 p-3 text-sm text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-indigo-400" /></label>
      <label className="mt-3 block text-sm font-medium">Days until interview<input required type="number" min={1} max={60} value={days} onChange={(event) => onDaysChange(Number(event.target.value))} className="mt-2 w-full rounded-xl border border-white/15 bg-white/10 p-3 text-sm text-white outline-none focus:ring-2 focus:ring-indigo-400" /></label>
      <button disabled={busy} className="mt-4 w-full rounded-xl bg-indigo-500 px-4 py-3 font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-wait disabled:opacity-60">{busy ? "Starting your kit…" : "Build my kit"}</button>
      {message && !compact && <p role={message === "Kit deleted." ? "status" : "alert"} className={`mt-3 text-sm ${message === "Kit deleted." ? "text-emerald-300" : "text-rose-300"}`}>{message}</p>}
    </form>
    <label className={`block rounded-2xl border border-slate-200 bg-white text-sm ${compact ? "p-4" : "p-5"}`}><span className="font-semibold">Prepare multiple roles</span><span className="mt-1 block text-xs leading-5 text-slate-500">Upload JSON or CSV with id, jd, company_url, and days.</span><input type="file" accept=".json,.csv,application/json,text/csv" onChange={(event) => { void onBatchFile(event.target.files?.[0]); event.currentTarget.value = ""; }} className="mt-3 block w-full text-xs" />{batchMessage && <span className="mt-2 block text-xs text-slate-600">{batchMessage}</span>}</label>
  </div>;
}

function PrepJourneyVisual() {
  const reduceMotion = useReducedMotion();
  const steps = [
    { number: "01", title: "Your role", detail: "Job description + company", icon: "↗" },
    { number: "02", title: "Focused research", detail: "Role context + public sources", icon: "⌕" },
    { number: "03", title: "Practice kit", detail: "Questions + answer guides", icon: "✳" },
  ];

  return <motion.div
    aria-label="PrepStudio turns a job description into a focused interview preparation kit"
    initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.98 }}
    animate={{ opacity: 1, y: 0, scale: 1 }}
    transition={{ duration: reduceMotion ? 0 : 0.65, ease: "easeOut" }}
    className="relative mx-auto w-full max-w-lg"
  >
    <div aria-hidden="true" className="absolute -inset-5 rounded-[2.5rem] bg-gradient-to-br from-indigo-200/60 via-sky-100/50 to-violet-100/60 blur-2xl" />
    <div className="relative overflow-hidden rounded-[1.75rem] border border-white/80 bg-white/90 p-5 shadow-[0_24px_70px_-28px_rgba(49,46,129,.35)] backdrop-blur sm:p-6">
      <div aria-hidden="true" className="absolute -right-12 -top-16 h-48 w-48 rounded-full bg-indigo-100/70 blur-3xl" />
      <div className="relative flex items-center justify-between gap-3">
        <div><p className="text-[10px] font-bold uppercase tracking-[.2em] text-indigo-600">Your preparation, in motion</p><p className="mt-1 text-sm font-semibold text-slate-900">From job post to ready</p></div>
        <motion.span animate={reduceMotion ? undefined : { scale: [1, 1.08, 1] }} transition={reduceMotion ? undefined : { duration: 2.8, repeat: Infinity, ease: "easeInOut" }} className="inline-flex items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1.5 text-[10px] font-semibold text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Built around you</motion.span>
      </div>

      <div className="relative mt-6 grid gap-4 sm:grid-cols-[1fr_.95fr] sm:items-center">
        <div className="relative space-y-3">
          <svg aria-hidden="true" viewBox="0 0 12 160" className="absolute left-[17px] top-7 h-[calc(100%-2.5rem)] w-3 overflow-visible"><motion.path d="M6 0V160" fill="none" stroke="url(#prep-line)" strokeWidth="2" strokeDasharray="4 5" initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ duration: reduceMotion ? 0 : 1.2, delay: 0.2 }} /><defs><linearGradient id="prep-line" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#6366f1"/><stop offset="1" stopColor="#a5b4fc"/></linearGradient></defs></svg>
          {steps.map((step, index) => <motion.div key={step.number} initial={reduceMotion ? false : { opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reduceMotion ? 0 : 0.4, delay: reduceMotion ? 0 : 0.2 + index * 0.14 }} className="relative flex items-center gap-3 rounded-xl border border-slate-100 bg-white/90 p-3 shadow-sm">
            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl text-sm font-semibold ${index === 2 ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20" : "bg-indigo-50 text-indigo-600"}`}>{step.icon}</span>
            <span className="min-w-0"><span className="block text-[10px] font-bold uppercase tracking-wider text-slate-400">{step.number} / 03</span><span className="mt-0.5 block text-xs font-semibold text-slate-800">{step.title}</span><span className="mt-0.5 block truncate text-[10px] text-slate-500">{step.detail}</span></span>
          </motion.div>)}
        </div>

        <motion.div animate={reduceMotion ? undefined : { y: [0, -5, 0] }} transition={reduceMotion ? undefined : { duration: 4.5, repeat: Infinity, ease: "easeInOut" }} className="relative rounded-2xl bg-slate-950 p-4 text-white shadow-xl shadow-indigo-950/15">
          <div className="flex items-center justify-between"><span className="text-[9px] font-bold uppercase tracking-[.18em] text-indigo-300">Your prep kit</span><span className="rounded-full bg-emerald-400/15 px-2 py-1 text-[9px] font-semibold text-emerald-300">READY</span></div>
          <p className="mt-3 text-sm font-semibold">A clear next step, every day.</p>
          <div className="mt-4 space-y-2">
            {["Role-specific questions", "Answer guides", "Study schedule"].map((item, index) => <motion.div key={item} initial={reduceMotion ? false : { opacity: 0, scaleX: 0.92 }} animate={{ opacity: 1, scaleX: 1 }} transition={{ duration: reduceMotion ? 0 : 0.35, delay: reduceMotion ? 0 : 0.6 + index * 0.12 }} className="flex origin-left items-center gap-2 rounded-lg border border-white/10 bg-white/[.06] px-2.5 py-2"><span className="grid h-5 w-5 place-items-center rounded-md bg-indigo-400/15 text-[10px] text-indigo-200">{index === 0 ? "?" : index === 1 ? "✓" : "↗"}</span><span className="text-[10px] text-slate-200">{item}</span></motion.div>)}
          </div>
          <div className="mt-4 flex gap-1.5" aria-hidden="true"><span className="h-1 flex-1 rounded-full bg-indigo-400"/><span className="h-1 flex-1 rounded-full bg-indigo-300/60"/><span className="h-1 flex-1 rounded-full bg-indigo-200/30"/></div>
        </motion.div>
      </div>
      <div aria-hidden="true" className="absolute -bottom-1 left-0 h-1 w-full bg-gradient-to-r from-indigo-500 via-violet-400 to-sky-300" />
    </div>
  </motion.div>;
}

export default function HomePage() {
  const reduceMotion = useReducedMotion();
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [kits, setKits] = useState<KitRecord[]>([]);
  const [active, setActive] = useState<KitRecord | null>(null);
  const kitLoadSequence = useRef(0);
  const [deleteTarget, setDeleteTarget] = useState<KitRecord | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deletingKitId, setDeletingKitId] = useState<string | null>(null);
  const [jd, setJd] = useState("");
  const [companyUrl, setCompanyUrl] = useState("");
  const [days, setDays] = useState(5);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [practiceIndex, setPracticeIndex] = useState(0);
  const [selectedFlashcardId, setSelectedFlashcardId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [showFlashcardTip, setShowFlashcardTip] = useState(false);
  const [selectedStudyDay, setSelectedStudyDay] = useState<number | null>(null);
  const [selectedStudyQuestionId, setSelectedStudyQuestionId] = useState<string | null>(null);
  const [studyProgress, setStudyProgress] = useState<StudyProgress>({});
  const [interviewDayChecks, setInterviewDayChecks] = useState<Record<string, string[]>>({});
  const [category, setCategory] = useState<QuestionFilter>("all");
  const [selectedBankQuestionId, setSelectedBankQuestionId] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [newRequirementId, setNewRequirementId] = useState("");
  const [batchMessage, setBatchMessage] = useState("");

  const refresh = useCallback(async () => {
    if (!user) return;
    const result = await request<{ kits: KitRecord[] }>("/kits");
    setKits(result.kits);
  }, [user]);

  useEffect(() => {
    request<{ user: User }>("/auth/me").then(({ user: current }) => setUser(current)).catch(() => {}).finally(() => setAuthReady(true));
  }, []);
  useEffect(() => { void refresh().catch(() => {}); }, [refresh]);
  useEffect(() => { setShowFlashcardTip(localStorage.getItem("prepstudio-hide-flashcard-tip") !== "true"); }, []);
  useEffect(() => {
    if (!active?.id) return;
    try {
      const saved = JSON.parse(localStorage.getItem(`prepstudio-interview-day-${active.id}`) || "[]");
      setInterviewDayChecks((current) => ({ ...current, [active.id]: Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [] }));
    } catch {
      setInterviewDayChecks((current) => ({ ...current, [active.id]: [] }));
    }
  }, [active?.id]);
  useEffect(() => {
    const running = kits.filter((kit) => kit.status === "running");
    if (!running.length) return;
    const timer = window.setInterval(async () => {
      const updates = await Promise.all(running.map((kit) => request<KitRecord>(`/kits/${kit.id}`).catch(() => kit)));
      setKits((current) => current.map((kit) => updates.find((update) => update.id === kit.id) ?? kit));
      setActive((current) => current ? updates.find((update) => update.id === current.id) ?? current : current);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [kits]);

  async function authSubmit(event: FormEvent) {
    event.preventDefault(); setAuthError("");
    try { const result = await request<{ user: User }>(`/auth/${registering ? "register" : "login"}`, { method: "POST", body: JSON.stringify({ email, password }) }); setUser(result.user); setShowAuth(false); setPassword(""); }
    catch (error) { setAuthError(error instanceof Error ? error.message : "Unable to sign in"); }
  }

  async function createKit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const result = await request<{ id: string; status: string }>("/kits", { method: "POST", body: JSON.stringify({ jd, company_url: companyUrl, days }) });
      const record = { id: result.id, status: result.status };
      setActive(record); setSelectedStudyDay(null); setSelectedStudyQuestionId(null); setStudyProgress({}); setSelectedBankQuestionId(null); setSelectedFlashcardId(null); setRevealed(false); setKits((current) => [record, ...current.filter((item) => item.id !== record.id)]); setJd("");
      if (result.status === "complete") await openKit(result.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not start generation"); }
    finally { setBusy(false); }
  }

  async function openKit(id: string) {
    const sequence = ++kitLoadSequence.current;
    setMessage("");
    setActive({ id, status: "loading" });
    setPracticeIndex(0); setSelectedFlashcardId(null); setSelectedStudyDay(null); setSelectedStudyQuestionId(null); setSelectedBankQuestionId(null); setRevealed(false);
    try {
      const record = await request<KitRecord>(`/kits/${id}`);
      if (sequence !== kitLoadSequence.current) return;
      setActive(record);
      try {
        const saved = JSON.parse(localStorage.getItem(`prepstudio-study-progress-${id}`) || "{}");
        setStudyProgress(Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((value) => typeof value === "string"))) as StudyProgress);
      } catch { setStudyProgress({}); }
    }
    catch (error) {
      if (sequence !== kitLoadSequence.current) return;
      setActive(null);
      setMessage(error instanceof Error ? error.message : "Could not load kit");
    }
  }

  async function deleteKit() {
    if (!deleteTarget || deletingKitId) return;
    const target = deleteTarget;
    setDeletingKitId(target.id);
    setDeleteError("");
    try {
      await request(`/kits/${target.id}`, { method: "DELETE" });
      setKits((current) => current.filter((item) => item.id !== target.id));
      localStorage.removeItem(`prepstudio-study-progress-${target.id}`);
      localStorage.removeItem(`prepstudio-interview-day-${target.id}`);
      if (active?.id === target.id) {
        kitLoadSequence.current++;
        setActive(null);
        setSelectedStudyDay(null); setSelectedStudyQuestionId(null); setSelectedBankQuestionId(null); setSelectedFlashcardId(null); setRevealed(false); setStudyProgress({});
        setMessage("Kit deleted.");
      }
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Could not delete this kit.");
    } finally {
      setDeletingKitId(null);
    }
  }

  function toggleInterviewDayCheck(itemId: string) {
    if (!active) return;
    const checked = new Set(interviewDayChecks[active.id] ?? []);
    if (checked.has(itemId)) checked.delete(itemId); else checked.add(itemId);
    const next = [...checked];
    setInterviewDayChecks((current) => ({ ...current, [active.id]: next }));
    localStorage.setItem(`prepstudio-interview-day-${active.id}`, JSON.stringify(next));
  }

  async function saveKit(next: Kit) {
    if (!active) return;
    const previous = active;
    setActive({ ...active, kit: next });
    try { const result = await request<{ kit: Kit }>(`/kits/${active.id}`, { method: "PATCH", body: JSON.stringify({ kit: next }) }); setActive((current) => current?.id === active.id ? { ...current, kit: result.kit } : current); }
    catch (error) { setActive(previous); setMessage(error instanceof Error ? error.message : "Save failed"); }
  }

  async function regenerate(section: RegenerationSection, selectedCategory?: QuestionCategory) {
    if (!active || regenerating) return;
    if (section === "question_category" && !selectedCategory) {
      setMessage("Choose a question category before regenerating.");
      return;
    }
    setRegenerating(section);
    setMessage(section === "company_brief" ? "Regenerating company brief…" : section === "schedule" ? "Regenerating study schedule…" : `Regenerating ${selectedCategory} questions…`);
    try {
      const result = await request<{ kit: Kit }>(`/kits/${active.id}/regenerate`, { method: "POST", body: JSON.stringify({ section, category: selectedCategory }) });
      const regeneratedQuestions = section === "question_category" ? result.kit.questions.filter((question) => question.category === selectedCategory) : [];
      if (section === "question_category" && !regeneratedQuestions.length) throw new Error(`The server returned no ${selectedCategory} questions. Please try again.`);
      const scheduleChanged = section === "schedule" && (
        result.kit.schedule.days_available !== active.kit?.schedule.days_available ||
        JSON.stringify(result.kit.schedule.days) !== JSON.stringify(active.kit?.schedule.days)
      );
      setActive((current) => current?.id === active.id ? { ...current, kit: result.kit } : current);
      if (section === "question_category" || scheduleChanged) {
        setStudyProgress({});
        localStorage.removeItem(`prepstudio-study-progress-${active.id}`);
        setSelectedStudyDay(null);
        setSelectedStudyQuestionId(null);
      }
      if (section === "question_category") { setCategory(selectedCategory!); setSelectedBankQuestionId(regeneratedQuestions[0]?.id ?? null); }
      setMessage(section === "company_brief" ? "Company brief regenerated." : section === "schedule" ? scheduleChanged ? "Study schedule regenerated and assignments updated." : "Schedule rebuilt. It is unchanged because the same questions and available days produce the same plan." : `${selectedCategory} questions regenerated (${regeneratedQuestions.length}).`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Regeneration failed"); }
    finally { setRegenerating(null); }
  }

  async function uploadBatch(file?: File) {
    if (!file) return;
    setBatchMessage("Reading batch file…");
    try {
      const text = await file.text();
      const cases = file.name.toLowerCase().endsWith(".csv")
        ? parseCsv(text).map((row, index) => ({ id: row.id || `case-${index + 1}`, jd: row.jd || "", company_url: row.company_url || "", days: Number(row.days) || 5 }))
        : JSON.parse(text);
      if (!Array.isArray(cases)) throw new Error("JSON batch must be an array of {id, jd, company_url, days} cases.");
      for (const item of cases) await request("/kits", { method: "POST", body: JSON.stringify({ jd: item.jd, company_url: item.company_url, days: item.days }) });
      setBatchMessage(`${cases.length} kit(s) queued.`); await refresh();
    } catch (error) { setBatchMessage(error instanceof Error ? error.message : "Could not read batch file"); }
  }

  function removeRequirement(kit: Kit, id: string) {
    void saveKit({
      ...kit,
      role: { ...kit.role, requirements: kit.role.requirements.filter((item) => item.id !== id) },
      questions: kit.questions.map((item) => ({ ...item, requirement_ids: item.requirement_ids.filter((reference) => reference !== id) })),
      flashcards: kit.flashcards.map((item) => ({ ...item, requirement_ids: item.requirement_ids.filter((reference) => reference !== id) })),
      coverage: { ...kit.coverage, uncovered_requirement_ids: kit.coverage.uncovered_requirement_ids.filter((reference) => reference !== id) },
    });
  }

  if (!authReady) return <main className="grid min-h-screen place-items-center text-slate-500">Loading PrepStudio…</main>;
  if (!user && !showAuth) return <LandingPage onSignIn={() => { setAuthError(""); setRegistering(false); setShowAuth(true); }} />;
  if (!user) return <main className="grid min-h-screen place-items-center bg-slate-950 px-4 py-10"><div className="w-full max-w-md"><button type="button" onClick={() => { setShowAuth(false); setAuthError(""); }} className="mb-4 rounded-lg px-2 py-2 text-sm text-slate-300 hover:bg-white/10 hover:text-white">← Back to PrepStudio</button><motion.form initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} onSubmit={authSubmit} className="rounded-3xl bg-white p-8 shadow-2xl">
    <p className="text-xs font-bold uppercase tracking-[.2em] text-indigo-600">PrepStudio</p><h1 className="mt-3 text-3xl font-semibold">{registering ? "Create your account" : "Welcome back"}</h1><p className="mt-2 text-slate-500">Build a focused prep plan from the role you want.</p>
    <label className="mt-7 block text-sm font-medium">Email<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-2 focus:ring-indigo-500" /></label>
    <label className="mt-4 block text-sm font-medium">Password<input required minLength={8} type="password" autoComplete={registering ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-2 focus:ring-indigo-500" /></label>
    {authError && <p role="alert" className="mt-4 text-sm text-rose-600">{authError}</p>}<button className="mt-6 w-full rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-500">{registering ? "Create account" : "Sign in"}</button>
    <button type="button" onClick={() => { setRegistering(!registering); setAuthError(""); }} className="mt-5 w-full text-sm text-slate-600 underline">{registering ? "I already have an account" : "Create an account"}</button>
  </motion.form></div></main>;

  const kit = active?.kit;
  const reviewCards = kit ? [...kit.flashcards].sort((a, b) => {
    const score = (flashcard: typeof a) => {
      const confidence = Number((flashcard as any).confidence ?? 3);
      const weight = Math.max(1, ...flashcard.requirement_ids.map((id) => kit.role.requirements.find((item) => item.id === id)?.priority === "must" ? 2 : 1));
      const difficulty = Math.max(1, ...flashcard.requirement_ids.map((id) => kit.questions.find((item) => item.requirement_ids.includes(id))?.difficulty ?? 1));
      return weight * difficulty * (6 - confidence);
    };
    return score(b) - score(a);
  }) : [];
  const weakSpots = kit ? kit.role.requirements.map((requirement) => {
    const cards = kit.flashcards.filter((flashcard) => flashcard.requirement_ids.includes(requirement.id));
    const question = kit.questions.find((item) => item.requirement_ids.includes(requirement.id));
    const ratedCards = cards.filter((item) => Number.isInteger((item as any).confidence) && Number((item as any).confidence) >= 1 && Number((item as any).confidence) <= 5);
    const confidence = ratedCards.length ? ratedCards.reduce((sum, item) => sum + Number((item as any).confidence), 0) / ratedCards.length : null;
    const difficulty = question?.difficulty ?? 1;
    return { requirement, score: confidence === null ? null : (requirement.priority === "must" ? 2 : 1) * difficulty * (6 - confidence), confidence, difficulty };
  }).filter((item) => item.confidence !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 5) : [];
  const card = reviewCards.find((item) => item.id === selectedFlashcardId) ?? reviewCards[practiceIndex];
  const activeDaysRemaining = active ? daysUntilInterview(active.createdAt, active.days ?? kit?.schedule.days_available) : null;
  const gamePlanRequirements = kit ? (kit.role.requirements.filter((item) => item.priority === "must").length ? kit.role.requirements.filter((item) => item.priority === "must") : kit.role.requirements).slice(0, 4) : [];
  const studyDays = kit?.schedule.days ?? [];
  const currentStudyDay = studyDays.find((day) => day.day === selectedStudyDay);
  const dayQuestions = kit && currentStudyDay ? currentStudyDay.question_ids.map((id) => kit.questions.find((question) => question.id === id)).filter((question): question is Kit["questions"][number] => Boolean(question)) : [];
  const dayCategoryQuestions = category === "all" ? dayQuestions : dayQuestions.filter((question) => question.category === category);
  const selectedStudyQuestion = dayCategoryQuestions.find((question) => question.id === selectedStudyQuestionId) ?? null;
  const bankQuestions = kit ? kit.questions.filter((question) => category === "all" || question.category === category) : [];
  const selectedBankQuestion = bankQuestions.find((question) => question.id === selectedBankQuestionId) ?? null;
  const regenerationSucceeded = message.endsWith("regenerated.") || message.includes(" questions regenerated (");
  const regenerationInProgress = message.startsWith("Regenerating");
  const dayComplete = (day: (typeof studyDays)[number]) => day.question_ids.every((id) => studyProgress[day.day]?.includes(id));
  function markStudyQuestionVisited(dayNumber: number, questionId: string) {
    if (!active) return;
    const completed = new Set(studyProgress[dayNumber] ?? []);
    if (completed.has(questionId)) return;
    completed.add(questionId);
    const next = { ...studyProgress, [dayNumber]: [...completed] };
    setStudyProgress(next);
    localStorage.setItem(`prepstudio-study-progress-${active.id}`, JSON.stringify(next));
  }
  function selectStudyQuestion(questionId: string) {
    if (!currentStudyDay) return;
    setSelectedStudyQuestionId(questionId);
    markStudyQuestionVisited(currentStudyDay.day, questionId);
  }
  function moveStudyQuestion(direction: -1 | 1) {
    const index = dayCategoryQuestions.findIndex((question) => question.id === selectedStudyQuestionId);
    const nextIndex = Math.max(0, Math.min(dayCategoryQuestions.length - 1, (index < 0 ? (direction === 1 ? -1 : 0) : index) + direction));
    const question = dayCategoryQuestions[nextIndex];
    if (question) selectStudyQuestion(question.id);
  }
  function updateQuestionsAndSchedule(questions: Kit["questions"]) {
    if (!kit || !active) return;
    void saveKit({ ...kit, questions, schedule: buildSchedule(kit.role.requirements, questions, kit.schedule.days_available), coverage: { ...checkCoverage(kit.role.requirements, questions), passes: kit.coverage.passes } });
    setStudyProgress({});
    localStorage.removeItem(`prepstudio-study-progress-${active.id}`);
    setSelectedStudyDay(null);
    setSelectedStudyQuestionId(null);
  }
  const kitBuilder = <NewKitBuilder jd={jd} onJdChange={setJd} companyUrl={companyUrl} onCompanyUrlChange={setCompanyUrl} days={days} onDaysChange={setDays} busy={busy} message={message} batchMessage={batchMessage} onSubmit={createKit} onBatchFile={(file) => { void uploadBatch(file); }} compact={Boolean(active)} />;
  return <main className="min-h-screen bg-[#f6f7fb] text-slate-900">
    <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/85 backdrop-blur"><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4"><button type="button" onClick={() => { setActive(null); setMessage(""); }} className="font-semibold tracking-tight">Prep<span className="text-indigo-600">Studio</span></button><div className="flex items-center gap-3 text-sm"><span className="hidden text-slate-500 sm:block">{user.email}</span><button onClick={async () => { await request("/auth/logout", { method: "POST" }); setUser(null); setActive(null); setShowAuth(false); }} className="rounded-lg border px-3 py-2 hover:bg-slate-50">Sign out</button></div></div></header>
    <div className={`mx-auto grid max-w-7xl gap-6 px-5 py-8 ${active ? "lg:grid-cols-[300px_minmax(0,1fr)]" : "lg:grid-cols-[280px_minmax(0,1fr)]"}`}>
      <aside className="space-y-5"><div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between gap-2"><p className="text-xs font-bold uppercase tracking-widest text-slate-400">Your kits</p>{active && <button type="button" onClick={() => { setActive(null); setMessage(""); }} className="rounded-lg px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50">+ New</button>}</div><div className="mt-3 space-y-2">{kits.map((item) => { const remainingDays = daysUntilInterview(item.createdAt, item.days); return <div key={item.id} className={`flex items-center gap-2 rounded-xl p-1 ${active?.id === item.id ? "bg-indigo-50" : "hover:bg-slate-50"}`}><button type="button" onClick={() => void openKit(item.id)} aria-current={active?.id === item.id ? "page" : undefined} className={`min-w-0 flex-1 rounded-lg p-2 text-left text-sm ${active?.id === item.id ? "text-indigo-800" : "text-slate-800"}`}><span className="block truncate font-medium">{item.kit?.role?.title || item.kit?.source?.company || "New interview kit"}</span><span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs capitalize text-slate-500">{item.status === "running" ? `Building · ${item.current_step?.replaceAll("_", " ") || "starting"}` : item.status}{item.status !== "running" && remainingDays !== null && <span className={`rounded-full px-2 py-0.5 font-semibold normal-case ${remainingDays === 0 ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>{remainingDays === 0 ? "Interview day" : `${remainingDays} ${remainingDays === 1 ? "day" : "days"} left`}</span>}</span></button><button type="button" aria-label={`Delete ${item.kit?.role?.title || item.kit?.source?.company || "interview kit"}`} title="Delete kit" onClick={() => { setDeleteError(""); setDeleteTarget(item); }} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-rose-600 text-lg font-semibold leading-none text-white transition hover:bg-rose-700 focus:outline-none focus:ring-2 focus:ring-rose-400 focus:ring-offset-2">−</button></div>; })}{!kits.length && <p className="py-3 text-sm text-slate-500">Your first kit will appear here.</p>}</div></div>{active && kitBuilder}</aside>
      <section className="min-w-0">{!active ? <div className="mx-auto w-full max-w-7xl py-4"><div className="grid items-center gap-8 lg:grid-cols-[1.05fr_.95fr] lg:gap-10"><motion.div initial={reduceMotion ? false : { opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduceMotion ? 0 : 0.55, ease: "easeOut" }} className="relative py-3 sm:py-6"><motion.p initial={reduceMotion ? false : { opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reduceMotion ? 0 : 0.4 }} className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.18em] text-indigo-600"><span className="h-2 w-2 rounded-full bg-indigo-500 shadow-[0_0_0_4px_rgba(99,102,241,.12)]"/>Your next interview starts here</motion.p><h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-[-.04em] text-slate-950 sm:text-5xl xl:text-6xl">Build a plan for the <span className="relative inline-block whitespace-nowrap bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-500 bg-clip-text text-transparent">role you want.<motion.span aria-hidden="true" initial={reduceMotion ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: reduceMotion ? 0 : 0.7, delay: reduceMotion ? 0 : 0.35, ease: "easeOut" }} className="absolute -bottom-1 left-0 h-[3px] w-full origin-left rounded-full bg-gradient-to-r from-indigo-500 to-violet-400"/></span></h1><p className="mt-5 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg sm:leading-8">Add the job description, the company website, and the time you have. <span className="font-medium text-slate-800">PrepStudio turns them into a focused plan</span> with research, questions, and daily practice.</p><div className="mt-6 flex flex-wrap gap-2 text-[11px] font-medium text-slate-600"><span className="rounded-full border border-slate-200 bg-white/80 px-3 py-1.5">Role-specific research</span><span className="rounded-full border border-slate-200 bg-white/80 px-3 py-1.5">Questions with answer guides</span><span className="rounded-full border border-slate-200 bg-white/80 px-3 py-1.5">A clear day-by-day plan</span></div></motion.div><PrepJourneyVisual/></div><div className="mt-8 flex justify-center">{kitBuilder}</div></div>
      : active.status === "running" ? <div className="rounded-3xl bg-white p-8 shadow-sm"><p className="text-sm font-semibold text-indigo-600">Research in progress</p><h1 className="mt-2 text-3xl font-semibold">Putting your kit together</h1><div className="mt-8 space-y-4">{pipelineSteps.filter((step) => step !== "fill_gaps" || active.steps_completed?.includes(step) || active.current_step === step).map((step) => { const done = active.steps_completed?.includes(step); const current = active.current_step === step; return <div key={step} className="flex items-center gap-3"><span className={`grid h-7 w-7 place-items-center rounded-full text-xs ${done ? "bg-emerald-100 text-emerald-700" : current ? "animate-pulse bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-400"}`}>{done ? "✓" : "•"}</span><span className={done || current ? "font-medium" : "text-slate-400"}>{step.replaceAll("_", " ")}</span></div>; })}</div></div>
      : active.status === "failed" ? <div role="alert" className="rounded-3xl border border-rose-200 bg-white p-8"><h1 className="text-2xl font-semibold">We couldn’t finish this kit</h1><p className="mt-3 text-rose-700">{active.error?.message || "An unexpected generation error occurred."}</p></div>
      : !kit ? <div className="rounded-3xl bg-white p-8">Loading kit…</div> : <div className="space-y-5">
        {message && <p role={regenerationInProgress || regenerationSucceeded ? "status" : "alert"} className={"rounded-xl border px-4 py-3 text-sm " + (regenerationSucceeded ? "border-emerald-200 bg-emerald-50 text-emerald-800" : regenerationInProgress ? "border-indigo-200 bg-indigo-50 text-indigo-800" : "border-rose-200 bg-rose-50 text-rose-800")}>{message}</p>}
        <div className="rounded-3xl bg-gradient-to-br from-indigo-950 via-slate-900 to-slate-800 p-7 text-white sm:p-9"><p className="text-xs font-bold uppercase tracking-[.18em] text-indigo-300">Your interview plan</p><h1 className="mt-3 text-3xl font-semibold sm:text-4xl">{kit.role.title || kit.source.role || "Preparation kit"}</h1><p className="mt-2 text-slate-300">{kit.source.company} · {activeDaysRemaining === 0 ? "Interview day" : activeDaysRemaining !== null ? `${activeDaysRemaining} ${activeDaysRemaining === 1 ? "day" : "days"} left` : `${kit.schedule.days_available} day preparation plan`}</p><div className="mt-6 flex flex-wrap gap-2"><span className="rounded-full bg-white/10 px-3 py-1.5 text-sm">{kit.role.requirements.length} role requirements</span><span className="rounded-full bg-white/10 px-3 py-1.5 text-sm">{kit.questions.length} practice questions</span><span className="rounded-full bg-white/10 px-3 py-1.5 text-sm">{kit.coverage.uncovered_requirement_ids.length ? `${kit.coverage.uncovered_requirement_ids.length} coverage gaps` : "Full requirement coverage"}</span></div></div>
        <article className="overflow-hidden rounded-3xl border border-indigo-100 bg-gradient-to-br from-white via-indigo-50/40 to-white p-5 shadow-sm sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><p className="text-xs font-bold uppercase tracking-[.18em] text-indigo-600">Before you walk in</p><h2 className="mt-2 text-2xl font-semibold tracking-tight">Interview Day Game Plan</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">A quick role recap, thoughtful questions, and a checklist to help you arrive prepared.</p></div>
            <span className={`inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-semibold ${activeDaysRemaining === 0 ? "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200" : "bg-indigo-100 text-indigo-800"}`}><span className={`h-2 w-2 rounded-full ${activeDaysRemaining === 0 ? "bg-emerald-600" : "bg-indigo-600"}`} />{activeDaysRemaining === 0 ? "Interview day" : activeDaysRemaining !== null ? `${activeDaysRemaining} ${activeDaysRemaining === 1 ? "day" : "days"} to go` : "Plan ready"}</span>
          </div>
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5">
              <p className="text-[11px] font-bold uppercase tracking-[.15em] text-slate-400">Company & role at a glance</p>
              <h3 className="mt-3 text-base font-semibold">{kit.source.company} · {kit.role.title || kit.source.role}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{kit.company_brief.what_they_do || kit.company_brief.summary}</p>
              <div className="mt-4 border-t border-slate-100 pt-4"><p className="text-xs font-semibold text-slate-700">Role priorities to keep in view</p>{gamePlanRequirements.length ? <ul className="mt-2 flex flex-wrap gap-2">{gamePlanRequirements.map((item) => <li key={item.id} className="rounded-lg bg-indigo-50 px-2.5 py-1.5 text-xs leading-5 text-indigo-800">{item.text}</li>)}</ul> : <p className="mt-2 text-sm text-slate-500">Review the role requirements in your kit before the interview.</p>}</div>
            </section>
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5">
              <p className="text-[11px] font-bold uppercase tracking-[.15em] text-slate-400">Questions you can ask</p>
              <p className="mt-2 text-sm text-slate-600">Choose one or two that feel natural for your conversation.</p>
              <ol className="mt-3 space-y-2.5">{[`What would success look like in the first few months for a ${kit.role.title || "person in this role"}?`, "What is the most important technical challenge the team is working through right now?", "How does the team share design feedback and make trade-offs when building a solution?"].map((question, index) => <li key={question} className="flex gap-3 text-sm leading-5 text-slate-700"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">{index + 1}</span><span>{question}</span></li>)}</ol>
            </section>
          </div>
          <section className="mt-4 rounded-2xl border border-slate-200/80 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[11px] font-bold uppercase tracking-[.15em] text-slate-400">Final check</p><h3 className="mt-1 font-semibold">Your ready-to-go checklist</h3></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">{interviewDayChecklist.filter((item) => interviewDayChecks[active.id]?.includes(item.id)).length} / {interviewDayChecklist.length} ready</span></div>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">{interviewDayChecklist.map((item) => { const checked = interviewDayChecks[active.id]?.includes(item.id) ?? false; return <li key={item.id}><label className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition ${checked ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-slate-200 bg-slate-50 text-slate-700 hover:border-indigo-200 hover:bg-indigo-50/50"}`}><input type="checkbox" checked={checked} onChange={() => toggleInterviewDayCheck(item.id)} className="h-4 w-4 shrink-0 accent-emerald-600" /><span>{item.label}</span></label></li>; })}</ul>
            <p className="mt-3 text-[11px] text-slate-400">Checklist progress is saved in this browser for this kit.</p>
          </section>
        </article>
        <div className="grid items-start gap-5 xl:grid-cols-2"><article className="min-w-0 rounded-2xl border bg-white p-6"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Company brief</h2><button disabled={regenerating !== null} onClick={() => void regenerate("company_brief")} className="shrink-0 text-xs text-indigo-600 disabled:text-slate-400">{regenerating === "company_brief" ? "Regenerating…" : "Regenerate brief"}</button></div><label className="mt-3 block text-xs font-medium text-slate-500">Company summary<textarea key={kit.company_brief.summary} aria-label="Edit company summary" defaultValue={kit.company_brief.summary} onBlur={(event) => { if (event.target.value !== kit.company_brief.summary) void saveKit({ ...kit, company_brief: { ...kit.company_brief, summary: event.target.value, meta: editedMeta(kit.company_brief) } }); }} className="mt-1 w-full resize-y rounded-lg border-0 bg-slate-50 p-3 text-sm leading-6 text-slate-800 outline-none focus:ring-2 focus:ring-indigo-400" rows={5}/></label><label className="mt-3 block text-xs font-medium text-slate-500">What they do<textarea key={kit.company_brief.what_they_do} aria-label="Edit what the company does" defaultValue={kit.company_brief.what_they_do} onBlur={(event) => { if (event.target.value !== kit.company_brief.what_they_do) void saveKit({ ...kit, company_brief: { ...kit.company_brief, what_they_do: event.target.value, meta: editedMeta(kit.company_brief) } }); }} className="mt-1 w-full resize-y rounded-lg border-0 bg-slate-50 p-3 text-sm leading-6 text-slate-700 outline-none focus:ring-2 focus:ring-indigo-400" rows={4}/></label><section className="mt-4 border-t border-slate-100 pt-4"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-slate-800">Research sources</h3><span className="text-xs text-slate-400">{new Set(kit.company_brief.sources.filter((source) => /^https?:\/\//i.test(source))).size} links</span></div>{kit.company_brief.sources.some((source) => /^https?:\/\//i.test(source)) ? <ul className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">{[...new Set(kit.company_brief.sources.filter((source) => /^https?:\/\//i.test(source)))].map((source) => { let label = source; try { const url = new URL(source); label = url.hostname.replace(/^www\./, "") + (url.pathname === "/" ? "" : url.pathname); } catch { /* retain the original source label */ } return <li key={source} className="min-w-0"><a href={source} target="_blank" rel="noreferrer" title={source} className="block min-w-0 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600 transition hover:bg-indigo-50 hover:text-indigo-700"><span className="block break-all">{label}</span><span className="mt-1 block text-[10px] text-slate-400">Open source ↗</span></a></li>; })}</ul> : <p className="mt-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">No public sources were found for this brief.</p>}</section></article>
        <article className="rounded-2xl border bg-white p-6"><h2 className="text-lg font-semibold">Role breakdown</h2><div className="mt-3 grid gap-2 sm:grid-cols-2"><label className="text-xs text-slate-500">Role title<input defaultValue={kit.role.title} onBlur={(event) => { if (event.target.value !== kit.role.title) void saveKit({ ...kit, role: { ...kit.role, title: event.target.value } }); }} className="mt-1 w-full rounded-lg bg-slate-50 p-2 text-sm text-slate-900" /></label><label className="text-xs text-slate-500">Seniority<input defaultValue={kit.role.seniority} onBlur={(event) => { if (event.target.value !== kit.role.seniority) void saveKit({ ...kit, role: { ...kit.role, seniority: event.target.value } }); }} className="mt-1 w-full rounded-lg bg-slate-50 p-2 text-sm text-slate-900" /></label></div><div className="mt-4 space-y-2">{kit.role.requirements.map((r) => <div key={r.id} className="flex items-start gap-2 border-t py-3"><input aria-label={`Edit requirement ${r.id}`} defaultValue={r.text} onBlur={(event) => { if (event.target.value !== r.text) void saveKit({ ...kit, role: { ...kit.role, requirements: kit.role.requirements.map((item) => item.id === r.id ? { ...item, text: event.target.value, meta: editedMeta(item) } : item) } }); }} className="min-w-0 flex-1 rounded-lg bg-slate-50 p-2 text-sm"/><select aria-label={`Requirement ${r.id} priority`} value={r.priority} onChange={(event) => void saveKit({ ...kit, role: { ...kit.role, requirements: kit.role.requirements.map((item) => item.id === r.id ? { ...item, priority: event.target.value as typeof r.priority, meta: editedMeta(item) } : item) } })} className="rounded-lg border px-2 py-2 text-xs"><option value="must">must</option><option value="nice">nice</option></select><button aria-label={`Delete requirement ${r.id}`} onClick={() => removeRequirement(kit, r.id)} className="rounded-lg px-2 py-2 text-xs text-rose-600 hover:bg-rose-50">×</button></div>)}</div><h3 className="mt-5 text-sm font-semibold">Responsibilities</h3>{kit.role.responsibilities.map((responsibility, index) => <textarea key={`${index}-${responsibility.slice(0, 12)}`} aria-label={`Edit responsibility ${index + 1}`} defaultValue={responsibility} onBlur={(event) => { if (event.target.value !== responsibility) void saveKit({ ...kit, role: { ...kit.role, responsibilities: kit.role.responsibilities.map((item, itemIndex) => itemIndex === index ? event.target.value : item) } }); }} className="mt-2 w-full rounded-lg bg-slate-50 p-2 text-sm" rows={2}/>)}</article></div>
        <article className="rounded-2xl border bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Question bank</h2><select aria-label="Filter questions by category" value={category} onChange={(event) => { setCategory(event.target.value as QuestionFilter); setSelectedStudyQuestionId(null); setSelectedBankQuestionId(null); }} className="rounded-lg border px-3 py-2 text-sm"><option value="all">All categories</option><option value="technical">Technical</option><option value="behavioural">Behavioural</option><option value="system-design">System design</option><option value="company-fit">Company fit</option></select><button disabled={category === "all" || regenerating !== null} onClick={() => { if (category !== "all") void regenerate("question_category", category); }} className="text-sm text-indigo-600 disabled:cursor-not-allowed disabled:text-slate-400">{regenerating === "question_category" ? "Regenerating…" : "Regenerate category"}</button></div>
          <p className="mt-2 text-xs text-slate-500">Choose a category to filter this bank and the selected study day. Select a number to open one question at a time.</p>
          {bankQuestions.length ? <div className="mt-4 flex flex-wrap gap-2">{bankQuestions.map((question, index) => <button key={question.id} type="button" aria-label={"Open question " + (index + 1)} aria-pressed={selectedBankQuestion?.id === question.id} onClick={() => setSelectedBankQuestionId(question.id)} className={"grid h-10 w-10 place-items-center rounded-lg border-2 border-slate-800 text-sm font-semibold " + (selectedBankQuestion?.id === question.id ? "bg-indigo-100 text-indigo-900" : "bg-white hover:bg-slate-100")}>{index + 1}</button>)}</div> : <p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No questions match this category yet. Regenerate it to create role-specific questions.</p>}
          {selectedBankQuestion && <div key={selectedBankQuestion.id} className="mt-4 rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><select aria-label="Move question to category" value={selectedBankQuestion.category} onChange={(event) => updateQuestionsAndSchedule(kit.questions.map((item) => item.id === selectedBankQuestion.id ? { ...item, category: event.target.value as typeof selectedBankQuestion.category, meta: editedMeta(item) } : item))} className="rounded-full bg-indigo-50 px-3 py-1.5 text-xs text-indigo-700"><option value="technical">technical</option><option value="behavioural">behavioural</option><option value="system-design">system-design</option><option value="company-fit">company-fit</option></select><div className="flex gap-2"><button type="button" onClick={() => { const remaining = kit.questions.filter((item) => item.id !== selectedBankQuestion.id); updateQuestionsAndSchedule(remaining); const next = bankQuestions.find((item) => item.id !== selectedBankQuestion.id); setSelectedBankQuestionId(next?.id ?? null); }} className="rounded-lg px-3 py-1.5 text-sm text-rose-600 hover:bg-rose-50">Delete question</button></div></div><textarea aria-label="Edit question" defaultValue={selectedBankQuestion.prompt} onBlur={(event) => { if (event.target.value !== selectedBankQuestion.prompt) void saveKit({ ...kit, questions: kit.questions.map((item) => item.id === selectedBankQuestion.id ? { ...item, prompt: event.target.value, meta: editedMeta(item) } : item) }); }} className="mt-3 w-full resize-y rounded-lg bg-slate-50 p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-400" rows={2}/><textarea aria-label="Edit answer outline" defaultValue={selectedBankQuestion.answer_outline} onBlur={(event) => { if (event.target.value !== selectedBankQuestion.answer_outline) void saveKit({ ...kit, questions: kit.questions.map((item) => item.id === selectedBankQuestion.id ? { ...item, answer_outline: event.target.value, meta: editedMeta(item) } : item) }); }} className="mt-2 w-full resize-y rounded-lg bg-slate-50 p-3 text-sm text-slate-600 outline-none focus:ring-2 focus:ring-indigo-400" rows={3}/></div>}
          <button type="button" onClick={() => { const id = "q" + Date.now(); const newQuestion = { id, requirement_ids: [], category: category === "all" ? "technical" as const : category as Kit["questions"][number]["category"], prompt: "", answer_outline: "", difficulty: 1 as const, meta: { source: "user_created" as const, pinned: true, version: 0 } }; const questions = [...kit.questions, newQuestion]; updateQuestionsAndSchedule(questions); setSelectedBankQuestionId(id); }} className="mt-4 rounded-xl border px-4 py-2 text-sm hover:bg-slate-50">+ Add a question</button>
        </article>
        <div className="grid gap-5 xl:grid-cols-2"><article className="rounded-2xl border bg-white p-6"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Study schedule</h2><button onClick={() => void regenerate("schedule")} className="text-xs text-indigo-600">Regenerate schedule</button></div><p className="mt-1 text-xs text-slate-500">Choose a day to see its questions. Finish every question to unlock the next day.</p><div className="mt-4 grid gap-2 sm:grid-cols-2">{studyDays.map((day, index) => { const locked = studyDays.slice(0, index).some((previous) => !dayComplete(previous)); const doneCount = day.question_ids.filter((id) => studyProgress[day.day]?.includes(id)).length; return <button key={day.day} type="button" disabled={locked} onClick={() => { setSelectedStudyDay(day.day); setSelectedStudyQuestionId(null); }} aria-pressed={selectedStudyDay === day.day} className={`rounded-xl p-4 text-left transition ${selectedStudyDay === day.day ? "bg-indigo-50 ring-2 ring-indigo-500" : "bg-slate-50 hover:bg-slate-100"} disabled:cursor-not-allowed disabled:opacity-50`}><p className="text-xs font-bold uppercase tracking-wide text-indigo-600">Day {day.day} · {day.minutes} min {dayComplete(day) && "· Complete ✓"}</p><p title={day.focus} className="mt-1 max-h-16 overflow-hidden text-sm font-medium leading-5">{day.focus}</p><p className="mt-2 text-xs text-slate-500">{doneCount} / {day.question_ids.length} questions complete{locked ? " · Finish earlier days to unlock" : ""}</p></button>; })}</div>{currentStudyDay ? <div className="mt-4 rounded-xl border border-slate-200 p-4"><h3 className="font-semibold">Day {currentStudyDay.day} focus notes</h3><p className="mt-1 text-sm leading-5 text-slate-700">{currentStudyDay.focus}</p><p className="mt-1 text-xs text-slate-500">About {currentStudyDay.minutes} minutes · {category === "all" ? "All categories" : category.replaceAll("-", " ")}</p>{category !== "all" && <p className="mt-2 text-xs text-slate-500">Day completion counts every category. Switch to All categories to review the remaining questions.</p>}{dayCategoryQuestions.length ? <><div className="mt-4 flex flex-wrap gap-2" aria-label="Questions for this day">{dayCategoryQuestions.map((question, index) => { const visited = studyProgress[currentStudyDay.day]?.includes(question.id) ?? false; return <button key={question.id} type="button" aria-label={"Question " + (index + 1) + (visited ? ", visited" : "")} aria-pressed={selectedStudyQuestionId === question.id} onClick={() => selectStudyQuestion(question.id)} className={"grid h-10 w-10 place-items-center rounded-lg border-2 border-slate-900 text-sm font-semibold transition " + (visited ? "border-emerald-700 bg-emerald-600 text-white" : selectedStudyQuestionId === question.id ? "bg-indigo-100 text-indigo-900" : "bg-white hover:bg-slate-100")}>{index + 1}</button>; })}</div>{selectedStudyQuestion ? <><div className="mt-4 rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">{selectedStudyQuestion.category.replaceAll("-", " ")}</p><h4 className="mt-2 font-medium">{selectedStudyQuestion.prompt}</h4><div className="mt-3 border-t border-slate-200 pt-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Answer guide</p><p className="mt-1 whitespace-pre-line text-sm leading-6 text-slate-700">{selectedStudyQuestion.answer_outline}</p></div></div><div className="mt-3 flex items-center justify-between"><button type="button" disabled={dayCategoryQuestions.findIndex((question) => question.id === selectedStudyQuestion.id) <= 0} onClick={() => moveStudyQuestion(-1)} className="rounded-lg border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40">Previous</button><p className="text-xs text-slate-500">{dayCategoryQuestions.findIndex((question) => question.id === selectedStudyQuestion.id) + 1} of {dayCategoryQuestions.length} · opening a question marks it visited</p><button type="button" disabled={dayCategoryQuestions.findIndex((question) => question.id === selectedStudyQuestion.id) >= dayCategoryQuestions.length - 1} onClick={() => moveStudyQuestion(1)} className="rounded-lg border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40">Next</button></div></> : <p className="mt-3 text-sm text-slate-500">Select a numbered box to open a question and its answer guide.</p>}</> : <p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No {category === "all" ? "" : category.replaceAll("-", " ") + " "}questions are assigned to this day.</p>}</div> : <p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">Select a day above to see its topic notes and numbered questions.</p>}</article>
        <article className="rounded-2xl border bg-white p-6">
          <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Flashcard practice</h2><span className="text-right text-xs text-slate-400">{kit.flashcards.filter((item) => Number.isInteger((item as any).confidence) && Number((item as any).confidence) >= 1 && Number((item as any).confidence) <= 5).length} / {kit.flashcards.length} rated</span></div>
          {card ? <>
            <div className="group relative mt-4" title="Try the prompt from memory, reveal the answer, then rate your confidence."><div className="min-h-36 rounded-2xl bg-indigo-50 p-5"><p className="text-xs font-bold uppercase tracking-wider text-indigo-500">{revealed ? "Answer" : "Prompt"}</p>{!revealed ? <textarea aria-label="Edit flashcard prompt" placeholder="Write a question or cue to test yourself…" defaultValue={card.front} onBlur={(event) => { if (event.target.value !== card.front) void saveKit({ ...kit, flashcards: kit.flashcards.map((item) => item.id === card.id ? { ...item, front: event.target.value, meta: editedMeta(item) } : item) }); }} className="mt-3 min-h-24 w-full resize-y bg-transparent leading-7 outline-none placeholder:text-slate-400 focus:ring-1 focus:ring-indigo-400" rows={3}/> : <><p className="mt-3 text-xs text-slate-500">Write the answer or memory aid here.</p><textarea aria-label="Edit flashcard answer" placeholder="Write the key points of a good answer…" defaultValue={card.back} onBlur={(event) => { if (event.target.value !== card.back) void saveKit({ ...kit, flashcards: kit.flashcards.map((item) => item.id === card.id ? { ...item, back: event.target.value, meta: editedMeta(item) } : item) }); }} className="mt-2 min-h-24 w-full resize-y border-t border-indigo-200 bg-transparent pt-3 text-sm leading-6 outline-none placeholder:text-slate-400 focus:ring-1 focus:ring-indigo-400" rows={3}/></>}</div>
              {showFlashcardTip && <div role="tooltip" className="pointer-events-none absolute left-3 right-3 top-3 z-10 flex items-start justify-between gap-3 rounded-xl border border-indigo-200 bg-white p-3 text-xs leading-5 text-slate-700 opacity-0 shadow-lg transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"><p>{revealed ? "Compare your answer with these key points and rate your confidence." : "Try answering from memory first. Reveal the answer to compare and learn."}</p><button type="button" aria-label="Got it, don't show this tip again" title="Got it — don't show this again" onClick={() => { setShowFlashcardTip(false); localStorage.setItem("prepstudio-hide-flashcard-tip", "true"); }} className="shrink-0 font-semibold text-slate-500 hover:text-slate-900">Got it ×</button></div>}
            </div>
            <label className="mt-3 block text-xs text-slate-500">Linked role requirement <select aria-label="Link flashcard to requirement" value={card.requirement_ids[0] ?? ""} onChange={(event) => void saveKit({ ...kit, flashcards: kit.flashcards.map((item) => item.id === card.id ? { ...item, requirement_ids: event.target.value ? [event.target.value] : [], meta: editedMeta(item) } : item) })} className="ml-2 rounded-lg border px-2 py-1 text-xs text-slate-700"><option value="">None</option>{kit.role.requirements.map((requirement) => <option key={requirement.id} value={requirement.id}>{requirement.text}</option>)}</select></label>
            <div className="mt-3 flex flex-wrap items-center gap-2"><button onClick={() => setRevealed(!revealed)} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">{revealed ? "Show prompt" : "Reveal answer"}</button><button onClick={() => { if (!reviewCards.length) return; const index = reviewCards.findIndex((item) => item.id === card.id); const next = reviewCards[(index + 1) % reviewCards.length]!; setSelectedFlashcardId(next.id); setRevealed(false); }} className="rounded-xl border px-4 py-2 text-sm" title="Move to the next card; cards needing review come first">Next card to review</button><span className="ml-1 text-xs text-slate-500" title="Rate yourself after trying to recall the answer.">Your confidence</span>{[1, 2, 3, 4, 5].map((rating) => <button key={rating} aria-label={"Confidence " + rating + " of 5"} aria-pressed={(card as any).confidence === rating} onClick={() => void saveKit({ ...kit, flashcards: kit.flashcards.map((item) => item.id === card.id ? { ...item, confidence: rating } : item) })} className={"h-9 w-9 rounded-full border text-xs " + ((card as any).confidence === rating ? "border-indigo-600 bg-indigo-600 text-white" : "hover:bg-slate-100")} title={rating + " of 5: " + (rating <= 2 ? "need more practice" : rating === 3 ? "partly know this" : "confident")}>{rating}</button>)}</div>
            <p className="mt-2 text-xs text-slate-500">1 = need more practice; 5 = confident. Ratings personalize Weak spots.</p>
          </> : <div className="mt-4 rounded-xl bg-slate-50 p-5"><p className="font-medium">No flashcards yet</p><p className="mt-1 text-sm text-slate-500">Add one to create a prompt and answer for practice.</p></div>}
          <div className="mt-4 flex gap-2"><button onClick={() => { const id = "f" + Date.now(); const newCard = { id, front: "", back: "", requirement_ids: [] as string[], meta: { source: "user_created" as const, pinned: true, version: 0 } }; void saveKit({ ...kit, flashcards: [...kit.flashcards, newCard] }); setSelectedFlashcardId(id); setRevealed(false); }} className="rounded-xl border px-3 py-2 text-xs">+ Add flashcard</button>{card && <button onClick={() => { const remaining = kit.flashcards.filter((item) => item.id !== card.id); void saveKit({ ...kit, flashcards: remaining }); setPracticeIndex(0); setSelectedFlashcardId(remaining[0]?.id ?? null); setRevealed(false); }} className="rounded-xl border px-3 py-2 text-xs text-rose-600">Delete card</button>}</div>
        </article></div>
        <article className="rounded-2xl border border-amber-200 bg-amber-50/70 p-6"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">Weak spots</h2><span className="text-xs text-amber-800">Based on your confidence ratings</span></div><p className="mt-2 text-xs leading-5 text-slate-600">Only flashcards you rate are included. The score combines your rating with requirement priority and question difficulty; a higher score means more review may help.</p>{weakSpots.length ? <ol className="mt-3 divide-y divide-amber-200">{weakSpots.map(({ requirement, score, confidence, difficulty }) => <li key={requirement.id} className="flex items-center justify-between gap-4 py-3"><div><p className="text-sm font-medium">{requirement.text}</p><p className="mt-1 text-xs text-slate-600">{requirement.priority} priority · difficulty {difficulty} · your confidence {confidence!.toFixed(1)}/5</p></div><span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-amber-900">{score!.toFixed(1)} review score</span></li>)}</ol> : <p className="mt-3 text-sm text-slate-600">No ratings yet, so there are no weak spots to calculate. Rate a flashcard and link it to a role requirement to start tracking.</p>}</article>
      </div>}</section>
    </div>
    {deleteTarget && <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 px-4 py-8 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget && !deletingKitId) setDeleteTarget(null); }} onKeyDown={(event) => { if (event.key === "Escape" && !deletingKitId) setDeleteTarget(null); }}><section role="dialog" aria-modal="true" aria-labelledby="delete-kit-title" aria-describedby="delete-kit-description" className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}><div className="flex items-start gap-4"><span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-rose-50 text-xl text-rose-600">−</span><div><h2 id="delete-kit-title" className="text-lg font-semibold">Delete this kit?</h2><p id="delete-kit-description" className="mt-2 text-sm leading-6 text-slate-600">“{deleteTarget.kit?.role?.title || deleteTarget.kit?.source?.company || "Interview kit"}” will be removed from your saved kits and deleted from your account.</p></div></div>{deleteError && <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{deleteError}</p>}<div className="mt-6 flex justify-end gap-3"><button type="button" autoFocus disabled={Boolean(deletingKitId)} onClick={() => { setDeleteTarget(null); setDeleteError(""); }} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">No</button><button type="button" disabled={Boolean(deletingKitId)} onClick={() => void deleteKit()} className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-wait disabled:opacity-60">{deletingKitId === deleteTarget.id ? "Deleting…" : "Delete"}</button></div></section></div>}
  </main>;
}
