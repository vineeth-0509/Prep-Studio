"use client";

import { motion, Reorder } from "framer-motion";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { checkCoverage, type Kit } from "@interview-prep/core";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api";
const pipelineSteps = ["extract_requirements", "discover_hiring_pages", "fetch_public_discussion", "generate_company_brief", "generate_questions", "build_schedule", "check_coverage", "fill_gaps", "validate_and_persist"];
type User = { id: string; email: string };
type KitRecord = { id: string; status: string; current_step?: string; steps_completed?: string[]; kit?: Kit; error?: { message: string } };
const editedMeta = (item: object) => {
  const previous = ((item as { meta?: unknown }).meta ?? {}) as { version?: number };
  return { source: "user_edited" as const, pinned: true, version: (previous.version ?? 0) + 1 };
};

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

export default function HomePage() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [kits, setKits] = useState<KitRecord[]>([]);
  const [active, setActive] = useState<KitRecord | null>(null);
  const [jd, setJd] = useState("");
  const [companyUrl, setCompanyUrl] = useState("");
  const [days, setDays] = useState(5);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [practiceIndex, setPracticeIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [category, setCategory] = useState("technical");
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
    try { const result = await request<{ user: User }>(`/auth/${registering ? "register" : "login"}`, { method: "POST", body: JSON.stringify({ email, password }) }); setUser(result.user); }
    catch (error) { setAuthError(error instanceof Error ? error.message : "Unable to sign in"); }
  }

  async function createKit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const result = await request<{ id: string; status: string }>("/kits", { method: "POST", body: JSON.stringify({ jd, company_url: companyUrl, days }) });
      const record = { id: result.id, status: result.status };
      setActive(record); setKits((current) => [record, ...current.filter((item) => item.id !== record.id)]); setJd("");
      if (result.status === "complete") await openKit(result.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not start generation"); }
    finally { setBusy(false); }
  }

  async function openKit(id: string) {
    try { setActive(await request<KitRecord>(`/kits/${id}`)); setPracticeIndex(0); setRevealed(false); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not load kit"); }
  }

  async function saveKit(next: Kit) {
    if (!active) return;
    const previous = active;
    setActive({ ...active, kit: next });
    try { const result = await request<{ kit: Kit }>(`/kits/${active.id}`, { method: "PATCH", body: JSON.stringify({ kit: next }) }); setActive((current) => current?.id === active.id ? { ...current, kit: result.kit } : current); }
    catch (error) { setActive(previous); setMessage(error instanceof Error ? error.message : "Save failed"); }
  }

  async function regenerate(section: string, selectedCategory?: string) {
    if (!active) return;
    setMessage("Regenerating section…");
    try {
      const result = await request<{ kit: Kit }>(`/kits/${active.id}/regenerate`, { method: "POST", body: JSON.stringify({ section, category: selectedCategory }) });
      setActive({ ...active, kit: result.kit }); setMessage("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Regeneration failed"); }
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

  if (!authReady) return <main className="grid min-h-screen place-items-center text-slate-500">Loading your workspace…</main>;
  if (!user) return <main className="grid min-h-screen place-items-center bg-slate-950 px-4 py-10"><motion.form initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} onSubmit={authSubmit} className="w-full max-w-md rounded-3xl bg-white p-8 shadow-2xl">
    <p className="text-xs font-bold uppercase tracking-[.2em] text-indigo-600">Interview Studio</p><h1 className="mt-3 text-3xl font-semibold">{registering ? "Create your account" : "Welcome back"}</h1><p className="mt-2 text-slate-500">Build a focused prep plan from the role you want.</p>
    <label className="mt-7 block text-sm font-medium">Email<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-2 focus:ring-indigo-500" /></label>
    <label className="mt-4 block text-sm font-medium">Password<input required minLength={8} type="password" autoComplete={registering ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:ring-2 focus:ring-indigo-500" /></label>
    {authError && <p role="alert" className="mt-4 text-sm text-rose-600">{authError}</p>}<button className="mt-6 w-full rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-500">{registering ? "Create account" : "Sign in"}</button>
    <button type="button" onClick={() => setRegistering(!registering)} className="mt-5 w-full text-sm text-slate-600 underline">{registering ? "I already have an account" : "Create an account"}</button>
  </motion.form></main>;

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
    const confidence = cards.length ? cards.reduce((sum, item) => sum + Number((item as any).confidence ?? 3), 0) / cards.length : 3;
    const difficulty = question?.difficulty ?? 1;
    return { requirement, score: (requirement.priority === "must" ? 2 : 1) * difficulty * (6 - confidence), confidence, difficulty };
  }).sort((a, b) => b.score - a.score).slice(0, 5) : [];
  const card = reviewCards[practiceIndex];
  return <main className="min-h-screen bg-[#f6f7fb] text-slate-900">
    <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/85 backdrop-blur"><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4"><a href="#" onClick={() => setActive(null)} className="font-semibold tracking-tight">Prep<span className="text-indigo-600">Studio</span></a><div className="flex items-center gap-3 text-sm"><span className="hidden text-slate-500 sm:block">{user.email}</span><button onClick={async () => { await request("/auth/logout", { method: "POST" }); setUser(null); setActive(null); }} className="rounded-lg border px-3 py-2 hover:bg-slate-50">Sign out</button></div></div></header>
    <div className="mx-auto grid max-w-7xl gap-8 px-5 py-8 lg:grid-cols-[280px_1fr]">
      <aside className="space-y-5"><div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs font-bold uppercase tracking-widest text-slate-400">Your kits</p><div className="mt-3 space-y-2">{kits.map((item) => <button key={item.id} onClick={() => void openKit(item.id)} className={`w-full rounded-xl p-3 text-left text-sm ${active?.id === item.id ? "bg-indigo-50 text-indigo-800" : "hover:bg-slate-50"}`}><span className="block truncate font-medium">{item.kit?.role?.title || item.kit?.source?.company || "New interview kit"}</span><span className="mt-1 block text-xs capitalize text-slate-500">{item.status === "running" ? `Building · ${item.current_step?.replaceAll("_", " ") || "starting"}` : item.status}</span></button>)}{!kits.length && <p className="py-3 text-sm text-slate-500">Your first kit will appear here.</p>}</div></div>
      <form onSubmit={createKit} className="rounded-2xl bg-slate-950 p-5 text-white"><p className="text-xs font-bold uppercase tracking-widest text-indigo-300">New preparation kit</p><label className="mt-4 block text-sm">Job description<textarea required rows={6} value={jd} onChange={(event) => setJd(event.target.value)} placeholder="Paste the role description here…" className="mt-2 w-full resize-y rounded-xl border border-white/15 bg-white/10 p-3 text-sm text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-indigo-400" /></label><label className="mt-3 block text-sm">Company website<input required type="url" value={companyUrl} onChange={(event) => setCompanyUrl(event.target.value)} placeholder="https://company.com" className="mt-2 w-full rounded-xl border border-white/15 bg-white/10 p-3 text-sm outline-none focus:ring-2 focus:ring-indigo-400" /></label><label className="mt-3 block text-sm">Days until interview<input required type="number" min={1} max={60} value={days} onChange={(event) => setDays(Number(event.target.value))} className="mt-2 w-full rounded-xl border border-white/15 bg-white/10 p-3 text-sm outline-none focus:ring-2 focus:ring-indigo-400" /></label><button disabled={busy} className="mt-4 w-full rounded-xl bg-indigo-500 px-4 py-3 text-sm font-semibold hover:bg-indigo-400 disabled:opacity-60">{busy ? "Starting…" : "Build my kit"}</button>{message && <p role="alert" className="mt-3 text-sm text-rose-300">{message}</p>}</form>
      <label className="block rounded-2xl border border-slate-200 bg-white p-5 text-sm"><span className="font-semibold">Prepare multiple roles</span><span className="mt-1 block text-xs text-slate-500">Upload JSON or CSV with id, jd, company_url and days.</span><input type="file" accept=".json,.csv,application/json,text/csv" onChange={(event) => void uploadBatch(event.target.files?.[0])} className="mt-3 block w-full text-xs" />{batchMessage && <span className="mt-2 block text-xs text-slate-600">{batchMessage}</span>}</label></aside>
      <section className="min-w-0">{!active ? <div className="flex min-h-[60vh] flex-col justify-center rounded-3xl border border-dashed border-slate-300 bg-white p-10"><p className="text-sm font-semibold text-indigo-600">A calmer way to prepare</p><h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">Make the days before your interview count.</h1><p className="mt-5 max-w-xl leading-7 text-slate-600">Paste a job description and company URL. Your kit combines role specific questions, flashcards, company research and a practical schedule.</p></div>
      : active.status === "running" ? <div className="rounded-3xl bg-white p-8 shadow-sm"><p className="text-sm font-semibold text-indigo-600">Research in progress</p><h1 className="mt-2 text-3xl font-semibold">Putting your kit together</h1><div className="mt-8 space-y-4">{pipelineSteps.filter((step) => step !== "fill_gaps" || active.steps_completed?.includes(step) || active.current_step === step).map((step) => { const done = active.steps_completed?.includes(step); const current = active.current_step === step; return <div key={step} className="flex items-center gap-3"><span className={`grid h-7 w-7 place-items-center rounded-full text-xs ${done ? "bg-emerald-100 text-emerald-700" : current ? "animate-pulse bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-400"}`}>{done ? "✓" : "•"}</span><span className={done || current ? "font-medium" : "text-slate-400"}>{step.replaceAll("_", " ")}</span></div>; })}</div></div>
      : active.status === "failed" ? <div role="alert" className="rounded-3xl border border-rose-200 bg-white p-8"><h1 className="text-2xl font-semibold">We couldn’t finish this kit</h1><p className="mt-3 text-rose-700">{active.error?.message || "An unexpected generation error occurred."}</p></div>
      : !kit ? <div className="rounded-3xl bg-white p-8">Loading kit…</div> : <div className="space-y-5">
        <div className="rounded-3xl bg-gradient-to-br from-indigo-950 via-slate-900 to-slate-800 p-7 text-white sm:p-9"><p className="text-xs font-bold uppercase tracking-[.18em] text-indigo-300">Your interview plan</p><h1 className="mt-3 text-3xl font-semibold sm:text-4xl">{kit.role.title || kit.source.role || "Preparation kit"}</h1><p className="mt-2 text-slate-300">{kit.source.company} · {kit.schedule.days_available} days to prepare</p><div className="mt-6 flex flex-wrap gap-2"><span className="rounded-full bg-white/10 px-3 py-1.5 text-sm">{kit.role.requirements.length} role requirements</span><span className="rounded-full bg-white/10 px-3 py-1.5 text-sm">{kit.questions.length} practice questions</span><span className="rounded-full bg-white/10 px-3 py-1.5 text-sm">{kit.coverage.uncovered_requirement_ids.length ? `${kit.coverage.uncovered_requirement_ids.length} coverage gaps` : "Full requirement coverage"}</span></div></div>
        <div className="grid gap-5 xl:grid-cols-2"><article className="rounded-2xl border bg-white p-6"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Company brief</h2><button onClick={() => void regenerate("company_brief")} className="text-xs text-indigo-600">Regenerate brief</button></div><textarea aria-label="Edit company summary" defaultValue={kit.company_brief.summary} onBlur={(event) => { if (event.target.value !== kit.company_brief.summary) void saveKit({ ...kit, company_brief: { ...kit.company_brief, summary: event.target.value, meta: editedMeta(kit.company_brief) } }); }} className="mt-3 w-full resize-y rounded-lg border-0 bg-slate-50 p-3 leading-7 outline-none focus:ring-2 focus:ring-indigo-400" rows={4}/><textarea aria-label="Edit what the company does" defaultValue={kit.company_brief.what_they_do} onBlur={(event) => { if (event.target.value !== kit.company_brief.what_they_do) void saveKit({ ...kit, company_brief: { ...kit.company_brief, what_they_do: event.target.value, meta: editedMeta(kit.company_brief) } }); }} className="mt-2 w-full resize-y rounded-lg border-0 bg-slate-50 p-3 text-sm leading-6 text-slate-600 outline-none focus:ring-2 focus:ring-indigo-400" rows={3}/><p className="mt-4 text-xs text-slate-400">Sources: {kit.company_brief.sources.length ? kit.company_brief.sources.join(" · ") : "No public sources found"}</p></article>
        <article className="rounded-2xl border bg-white p-6"><h2 className="text-lg font-semibold">Role breakdown</h2><div className="mt-3 grid gap-2 sm:grid-cols-2"><label className="text-xs text-slate-500">Role title<input defaultValue={kit.role.title} onBlur={(event) => { if (event.target.value !== kit.role.title) void saveKit({ ...kit, role: { ...kit.role, title: event.target.value } }); }} className="mt-1 w-full rounded-lg bg-slate-50 p-2 text-sm text-slate-900" /></label><label className="text-xs text-slate-500">Seniority<input defaultValue={kit.role.seniority} onBlur={(event) => { if (event.target.value !== kit.role.seniority) void saveKit({ ...kit, role: { ...kit.role, seniority: event.target.value } }); }} className="mt-1 w-full rounded-lg bg-slate-50 p-2 text-sm text-slate-900" /></label></div><div className="mt-4 space-y-2">{kit.role.requirements.map((r) => <div key={r.id} className="flex items-start gap-2 border-t py-3"><input aria-label={`Edit requirement ${r.id}`} defaultValue={r.text} onBlur={(event) => { if (event.target.value !== r.text) void saveKit({ ...kit, role: { ...kit.role, requirements: kit.role.requirements.map((item) => item.id === r.id ? { ...item, text: event.target.value, meta: editedMeta(item) } : item) } }); }} className="min-w-0 flex-1 rounded-lg bg-slate-50 p-2 text-sm"/><select aria-label={`Requirement ${r.id} priority`} value={r.priority} onChange={(event) => void saveKit({ ...kit, role: { ...kit.role, requirements: kit.role.requirements.map((item) => item.id === r.id ? { ...item, priority: event.target.value as typeof r.priority, meta: editedMeta(item) } : item) } })} className="rounded-lg border px-2 py-2 text-xs"><option value="must">must</option><option value="nice">nice</option></select><button aria-label={`Delete requirement ${r.id}`} onClick={() => removeRequirement(kit, r.id)} className="rounded-lg px-2 py-2 text-xs text-rose-600 hover:bg-rose-50">×</button></div>)}</div><h3 className="mt-5 text-sm font-semibold">Responsibilities</h3>{kit.role.responsibilities.map((responsibility, index) => <textarea key={`${index}-${responsibility.slice(0, 12)}`} aria-label={`Edit responsibility ${index + 1}`} defaultValue={responsibility} onBlur={(event) => { if (event.target.value !== responsibility) void saveKit({ ...kit, role: { ...kit.role, responsibilities: kit.role.responsibilities.map((item, itemIndex) => itemIndex === index ? event.target.value : item) } }); }} className="mt-2 w-full rounded-lg bg-slate-50 p-2 text-sm" rows={2}/>)}</article></div>
        <article className="rounded-2xl border bg-white p-6"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Question bank</h2><select onChange={(event) => setCategory(event.target.value)} className="rounded-lg border px-2 py-1 text-xs"><option value="technical">Technical</option><option value="behavioural">Behavioural</option><option value="system-design">System design</option><option value="company-fit">Company fit</option></select><button onClick={() => void regenerate("question_category", category)} className="text-xs text-indigo-600">Regenerate category</button></div><Reorder.Group axis="y" values={kit.questions} onReorder={(questions) => void saveKit({ ...kit, questions })} className="mt-4 space-y-3">{kit.questions.map((q, index) => <Reorder.Item key={q.id} value={q} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><select aria-label="Move question to category" value={q.category} onChange={(event) => void saveKit({ ...kit, questions: kit.questions.map((item) => item.id === q.id ? { ...item, category: event.target.value as typeof q.category } : item) })} className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs text-indigo-700"><option value="technical">technical</option><option value="behavioural">behavioural</option><option value="system-design">system-design</option><option value="company-fit">company-fit</option></select><div className="flex gap-1"><button aria-label="Move up" disabled={index === 0} onClick={(event) => { event.stopPropagation(); const next = [...kit.questions]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; void saveKit({ ...kit, questions: next }); }} className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100">↑</button><button aria-label="Delete question" onClick={() => void saveKit({ ...kit, questions: kit.questions.filter((item) => item.id !== q.id), schedule: { ...kit.schedule, days: kit.schedule.days.map((day) => ({ ...day, question_ids: day.question_ids.filter((id) => id !== q.id) })) } })} className="rounded px-2 py-1 text-rose-500 hover:bg-rose-50">Delete</button></div></div><textarea aria-label="Edit question" defaultValue={q.prompt} onBlur={(event) => { if (event.target.value !== q.prompt) void saveKit({ ...kit, questions: kit.questions.map((item) => item.id === q.id ? { ...item, prompt: event.target.value, meta: editedMeta(item) } : item) }); }} className="mt-3 w-full resize-y rounded-lg border-0 bg-slate-50 p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-400" rows={2}/><textarea aria-label="Edit answer outline" defaultValue={q.answer_outline} onBlur={(event) => { if (event.target.value !== q.answer_outline) void saveKit({ ...kit, questions: kit.questions.map((item) => item.id === q.id ? { ...item, answer_outline: event.target.value, meta: editedMeta(item) } : item) }); }} className="mt-2 w-full resize-y rounded-lg border-0 bg-slate-50 p-3 text-sm text-slate-600 outline-none focus:ring-2 focus:ring-indigo-400" rows={2}/></Reorder.Item>)}</Reorder.Group><button onClick={() => void saveKit({ ...kit, questions: [...kit.questions, { id: `q${Date.now()}`, requirement_ids: [], category: "technical", prompt: "New question", answer_outline: "", difficulty: 1, meta: { source: "user_created", pinned: true, version: 0 } }] })} className="mt-4 rounded-xl border px-4 py-2 text-sm hover:bg-slate-50">+ Add a question</button></article>
        <div className="grid gap-5 xl:grid-cols-2"><article className="rounded-2xl border bg-white p-6"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Study schedule</h2><button onClick={() => void regenerate("schedule")} className="text-xs text-indigo-600">Regenerate schedule</button></div><div className="mt-4 grid gap-2 sm:grid-cols-2">{kit.schedule.days.map((day) => <div key={day.day} className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-bold uppercase tracking-wide text-indigo-600">Day {day.day} · {day.minutes} min</p><input aria-label={`Edit day ${day.day} focus`} defaultValue={day.focus} onBlur={(event) => { if (event.target.value !== day.focus) void saveKit({ ...kit, schedule: { ...kit.schedule, days: kit.schedule.days.map((item) => item.day === day.day ? { ...item, focus: event.target.value, meta: editedMeta(item) } : item) } }); }} className="mt-1 w-full bg-transparent text-sm font-medium outline-none focus:underline"/><p className="mt-2 text-xs text-slate-500">{day.question_ids.length} questions</p></div>)}</div></article>
        <article className="rounded-2xl border bg-white p-6"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Flashcard practice</h2><span className="text-xs text-slate-400">{kit.flashcards.filter((item) => Number((item as any).confidence) >= 1).length} / {kit.flashcards.length} cards covered</span></div>{card ? <><div className="mt-4 min-h-36 rounded-2xl bg-indigo-50 p-5"><p className="text-xs font-bold uppercase tracking-wider text-indigo-500">{revealed ? "Answer" : "Prompt"}</p><textarea aria-label="Edit flashcard prompt" defaultValue={card.front} onBlur={(event) => { if (event.target.value !== card.front) void saveKit({ ...kit, flashcards: kit.flashcards.map((item) => item.id === card.id ? { ...item, front: event.target.value, meta: editedMeta(item) } : item) }); }} className="mt-3 w-full resize-y bg-transparent leading-7 outline-none focus:ring-1 focus:ring-indigo-400" rows={2}/>{revealed && <textarea aria-label="Edit flashcard answer" defaultValue={card.back} onBlur={(event) => { if (event.target.value !== card.back) void saveKit({ ...kit, flashcards: kit.flashcards.map((item) => item.id === card.id ? { ...item, back: event.target.value, meta: editedMeta(item) } : item) }); }} className="mt-3 w-full resize-y border-t border-indigo-200 bg-transparent pt-3 text-sm leading-6 outline-none focus:ring-1 focus:ring-indigo-400" rows={3}/>}</div><div className="mt-3 flex flex-wrap gap-2"><button onClick={() => setRevealed(!revealed)} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">{revealed ? "Show prompt" : "Reveal answer"}</button><button onClick={() => { setPracticeIndex((practiceIndex + 1) % kit.flashcards.length); setRevealed(false); }} className="rounded-xl border px-4 py-2 text-sm">Next weakest</button><span className="self-center text-xs text-slate-500">Confidence</span>{[1, 2, 3, 4, 5].map((rating) => <button key={rating} aria-label={`Confidence ${rating} of 5`} onClick={() => void saveKit({ ...kit, flashcards: kit.flashcards.map((item) => item.id === card.id ? { ...item, confidence: rating } : item) })} className={`h-8 w-8 rounded-full border text-xs ${(card as any).confidence === rating ? "border-indigo-600 bg-indigo-600 text-white" : "hover:bg-slate-100"}`}>{rating}</button>)}</div></> : <p className="mt-4 text-sm text-slate-500">Flashcards will appear when generated.</p>}<div className="mt-4 flex gap-2"><button onClick={() => void saveKit({ ...kit, flashcards: [...kit.flashcards, { id: `f${Date.now()}`, front: "New prompt", back: "Write your answer notes", requirement_ids: [], meta: { source: "user_created", pinned: true, version: 0 } }] })} className="rounded-xl border px-3 py-2 text-xs">+ Add flashcard</button>{card && <button onClick={() => { const remaining = kit.flashcards.filter((item) => item.id !== card.id); void saveKit({ ...kit, flashcards: remaining }); setPracticeIndex(0); }} className="rounded-xl border px-3 py-2 text-xs text-rose-600">Delete card</button>}</div></article></div>
        <article className="rounded-2xl border border-amber-200 bg-amber-50/70 p-6"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Weak spots</h2><span className="text-xs text-amber-800">Confidence × priority × difficulty</span></div>{weakSpots.length ? <ol className="mt-3 divide-y divide-amber-200">{weakSpots.map(({ requirement, score, confidence, difficulty }) => <li key={requirement.id} className="flex items-center justify-between gap-4 py-3"><div><p className="text-sm font-medium">{requirement.text}</p><p className="mt-1 text-xs text-slate-600">{requirement.priority} · difficulty {difficulty} · confidence {confidence.toFixed(1)}/5</p></div><span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-amber-900">{score.toFixed(1)}</span></li>)}</ol> : <p className="mt-3 text-sm text-slate-600">Practice cards linked to requirements to see what needs more review.</p>}</article>
      </div>}</section>
    </div>
  </main>;
}
