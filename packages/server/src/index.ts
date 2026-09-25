import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
const rootEnv = resolve(process.cwd(), "../../.env");
dotenv.config({ path: process.env.ENV_FILE || (existsSync(rootEnv) ? rootEnv : resolve(process.cwd(), ".env")) });
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose, { Schema } from "mongoose";
import { buildSchedule, checkCoverage, generateKit, inputHash, KitSchema, regenerateCategoryQuestions, regenerateCompanyBrief, type Kit } from "@interview-prep/core";

const app = express();
const PORT = Number(process.env.PORT || 4000);
if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) throw new Error("JWT_SECRET must be set in production");
const JWT_SECRET = process.env.JWT_SECRET || "development-only-change-this-secret";
const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: (process.env.NODE_ENV === "production" ? "none" : "lax") as "none" | "lax", path: "/" };
app.use(cors({ origin: process.env.WEB_ORIGIN || "http://localhost:3000", credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
function rateLimit(limit: number, windowMs: number) {
  const buckets = new Map<string, { count: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.reset <= now) { bucket = { count: 0, reset: now + windowMs }; buckets.set(key, bucket); }
    bucket.count++;
    res.setHeader("RateLimit-Limit", limit);
    res.setHeader("RateLimit-Remaining", Math.max(0, limit - bucket.count));
    if (bucket.count > limit) return res.status(429).json({ code: "RATE_LIMITED", message: "Too many requests. Please try again later." });
    return next();
  };
}
const authLimiter = rateLimit(20, 15 * 60 * 1000);
const generationLimiter = rateLimit(10, 60 * 60 * 1000);

const userSchema = new Schema({ email: { type: String, unique: true, required: true, lowercase: true }, password_hash: { type: String, required: true } }, { timestamps: true });
const kitSchema = new Schema({ owner_id: { type: Schema.Types.ObjectId, required: true, index: true }, input_hash: { type: String, required: true }, jd: String, company_url: String, days: Number, kit: Schema.Types.Mixed, partial_results: { type: Schema.Types.Mixed, default: {} }, status: { type: String, enum: ["running", "complete", "failed"], default: "running" }, current_step: String, steps_completed: [String], error: Schema.Types.Mixed }, { timestamps: true });
kitSchema.index({ owner_id: 1, input_hash: 1 }, { unique: true });
const User = mongoose.model("User", userSchema);
const KitModel = mongoose.model("Kit", kitSchema);
type AuthedRequest = Request & { userId?: string };
function asyncHandler<T extends Request>(handler: (req: T, res: Response) => Promise<unknown>) {
  return ((req: Request, res: Response, next: NextFunction) => { void handler(req as T, res).catch(next); });
}
function authenticate(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ code: "UNAUTHENTICATED", message: "Please sign in." });
  try { req.userId = (jwt.verify(token, JWT_SECRET) as { sub: string }).sub; return next(); }
  catch { return res.status(401).json({ code: "SESSION_EXPIRED", message: "Your session has expired. Please sign in again." }); }
}
function issueSession(res: Response, userId: string) {
  res.cookie("session", jwt.sign({}, JWT_SECRET, { subject: userId, expiresIn: "7d" }), { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });
}
async function runGeneration(record: { _id: unknown }, jd: string, companyUrl: string, days: number) {
  let runningStep = "starting";
  try {
    const kit = await generateKit({ jd, company_url: companyUrl, days, onProgress: async ({ step, status, partial }) => {
      runningStep = step;
      if (status === "started") await KitModel.updateOne({ _id: record._id }, { current_step: step });
      const update: Record<string, unknown> = {};
      if (status === "completed" || status === "skipped") update.$addToSet = { steps_completed: step };
      if (partial !== undefined) update[`partial_results.${step}`] = partial;
      if (Object.keys(update).length) await KitModel.updateOne({ _id: record._id }, update);
    } });
    await KitModel.updateOne({ _id: record._id }, { kit, status: "complete", current_step: "complete" });
  } catch (error) {
    await KitModel.updateOne({ _id: record._id }, { status: "failed", error: { code: "GENERATION_FAILED", step: runningStep, message: error instanceof Error ? error.message : "Generation failed." } });
  }
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.post("/api/auth/register", authLimiter, asyncHandler(async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || password.length > 200) return res.status(400).json({ code: "INVALID_INPUT", message: "Enter a valid email and a password of at least 8 characters." });
  try {
    const user = await User.create({ email, password_hash: await bcrypt.hash(password, 12) });
    issueSession(res, String(user._id));
    return res.status(201).json({ user: { id: String(user._id), email } });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return res.status(409).json({ code: "EMAIL_EXISTS", message: "An account with that email already exists." });
    return res.status(500).json({ code: "REGISTER_FAILED", message: "Unable to create account." });
  }
}));
app.post("/api/auth/login", authLimiter, asyncHandler(async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const user = await User.findOne({ email });
  if (!user || !await bcrypt.compare(String(req.body.password || ""), user.get("password_hash"))) return res.status(401).json({ code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." });
  issueSession(res, String(user._id));
  return res.json({ user: { id: String(user._id), email } });
}));
app.post("/api/auth/logout", (_req, res) => { res.clearCookie("session", cookieOptions); res.json({ status: "ok" }); });
app.get("/api/auth/me", authenticate, asyncHandler<AuthedRequest>(async (req, res) => {
  const user = await User.findById(req.userId).select("email");
  return user ? res.json({ user: { id: String(user._id), email: user.get("email") } }) : res.status(401).json({ code: "SESSION_EXPIRED", message: "Please sign in again." });
}));

app.get("/api/kits", authenticate, asyncHandler<AuthedRequest>(async (req, res) => {
  const kits = await KitModel.find({ owner_id: req.userId }).sort({ createdAt: -1 }).select("status current_step steps_completed kit.source kit.role.title error createdAt");
  return res.json({ kits: kits.map((record) => {
    const kit = record.get("kit") as Kit | undefined;
    return {
      id: String(record._id),
      status: record.get("status"),
      current_step: record.get("current_step"),
      steps_completed: record.get("steps_completed"),
      kit: kit ? { source: kit.source, role: { title: kit.role.title } } : undefined,
      error: record.get("error"),
    };
  }) });
}));
app.post("/api/kits", authenticate, generationLimiter, asyncHandler<AuthedRequest>(async (req, res) => {
  const { jd, company_url: companyUrl, days } = req.body ?? {};
  if (typeof jd !== "string" || !jd.trim() || typeof companyUrl !== "string" || !Number.isInteger(days) || days < 1 || days > 60) return res.status(400).json({ code: "INVALID_INPUT", message: "Provide job description text, a company URL, and 1–60 days." });
  try { new URL(companyUrl); } catch { return res.status(400).json({ code: "INVALID_URL", message: "Enter a valid company URL." }); }
  const hash = inputHash({ jd, company_url: companyUrl });
  const prior = await KitModel.findOne({ owner_id: req.userId, input_hash: hash }).sort({ createdAt: -1 });
  if (prior?.get("status") === "running") return res.status(202).json({ id: String(prior._id), status: "running", reused: true });
  if (prior?.get("status") === "complete") {
    if (prior.get("days") !== days) {
      const cached = KitSchema.parse(prior.get("kit"));
      const schedule = buildSchedule(cached.role.requirements, cached.questions, days);
      schedule.days = schedule.days.map((day) => ({ ...day, meta: { source: "generated" as const, pinned: false, version: 0 } }));
      cached.schedule = schedule;
      await KitModel.updateOne({ _id: prior._id }, { kit: KitSchema.parse(cached), days });
    }
    return res.status(200).json({ id: String(prior._id), status: "complete", reused: true });
  }
  const record = prior ?? await KitModel.create({ owner_id: req.userId, input_hash: hash, jd, company_url: companyUrl, days, status: "running", steps_completed: [] });
  if (prior) await KitModel.updateOne({ _id: prior._id }, { $set: { status: "running", current_step: null, steps_completed: [], error: null, kit: null, partial_results: {}, days } });
  void runGeneration(record, jd, companyUrl, days);
  return res.status(202).json({ id: String(record._id), status: "running" });
}));
app.get("/api/kits/:id", authenticate, asyncHandler<AuthedRequest>(async (req, res) => {
  const record = await KitModel.findOne({ _id: req.params.id, owner_id: req.userId });
  if (!record) return res.status(404).json({ code: "NOT_FOUND", message: "Kit not found." });
  return res.json({ id: String(record._id), status: record.get("status"), current_step: record.get("current_step"), steps_completed: record.get("steps_completed"), kit: record.get("kit"), error: record.get("error") });
}));
app.get("/api/kits/:id/status", authenticate, asyncHandler<AuthedRequest>(async (req, res) => {
  const record = await KitModel.findOne({ _id: req.params.id, owner_id: req.userId }).select("status current_step steps_completed error");
  if (!record) return res.status(404).json({ code: "NOT_FOUND", message: "Kit not found." });
  return res.json({ status: record.get("status"), current_step: record.get("current_step"), steps_completed: record.get("steps_completed"), error: record.get("error") });
}));
app.patch("/api/kits/:id", authenticate, asyncHandler<AuthedRequest>(async (req, res) => {
  const parsed = KitSchema.safeParse(req.body?.kit);
  if (!parsed.success) return res.status(400).json({ code: "INVALID_KIT", message: "The kit does not match the required structure.", issues: parsed.error.issues });
  const kit = { ...parsed.data, coverage: { ...checkCoverage(parsed.data.role.requirements, parsed.data.questions), passes: parsed.data.coverage.passes } };
  const record = await KitModel.findOneAndUpdate({ _id: req.params.id, owner_id: req.userId, status: "complete" }, { kit: KitSchema.parse(kit) }, { new: true });
  return record ? res.json({ kit: record.get("kit") }) : res.status(404).json({ code: "NOT_FOUND", message: "Kit not found." });
}));
app.post("/api/kits/:id/regenerate", authenticate, asyncHandler<AuthedRequest>(async (req, res) => {
  const record = await KitModel.findOne({ _id: req.params.id, owner_id: req.userId, status: "complete" });
  if (!record) return res.status(404).json({ code: "NOT_FOUND", message: "Kit not found." });
  const original = KitSchema.parse(record.get("kit"));
  const section = req.body?.section as string;
  const category = req.body?.category as string | undefined;
  if (section !== "company_brief" && section !== "schedule" && section !== "question_category") return res.status(400).json({ code: "INVALID_SECTION", message: "Choose company_brief, schedule, or question_category." });
  if (section === "question_category" && !["technical", "behavioural", "system-design", "company-fit"].includes(category || "")) return res.status(400).json({ code: "INVALID_CATEGORY", message: "Choose a valid question category." });
  try {
    const updated = structuredClone(original) as Kit;
    if (section === "company_brief") {
      // Clicking regenerate is an explicit request to replace even a previously edited brief.
      updated.company_brief = await regenerateCompanyBrief(String(record.get("company_url") || original.source.company_url));
    } else if (section === "question_category") {
      const categoryQuestions = updated.questions.filter((question) => question.category === category);
      const pinned = categoryQuestions.filter((question) => (question as any).meta?.pinned);
      const other = updated.questions.filter((question) => question.category !== category);
      const generatedQuestions = await regenerateCategoryQuestions(String(record.get("jd") || ""), String(record.get("company_url") || original.source.company_url), updated.role.requirements, category as Kit["questions"][number]["category"]);
      if (!generatedQuestions.length) throw new Error(`No ${category} questions were returned. Please try again.`);
      const generated = generatedQuestions.map((question) => ({ ...question, id: `qregen_${randomUUID()}` }));
      updated.questions = [...other, ...pinned, ...generated];
      updated.coverage = checkCoverage(updated.role.requirements, updated.questions);
      updated.coverage.passes = Math.max(1, original.coverage.passes);
      const rebuilt = buildSchedule(updated.role.requirements, updated.questions, updated.schedule.days_available);
      updated.schedule = { ...rebuilt, days: rebuilt.days.map((day) => ({ ...day, meta: { source: "generated" as const, pinned: false, version: 0 } })) };
    } else {
      const rebuilt = buildSchedule(updated.role.requirements, updated.questions, updated.schedule.days_available);
      const next = rebuilt.days.map((day) => ({ ...day, meta: { source: "generated" as const, pinned: false, version: 0 } }));
      updated.schedule = { ...rebuilt, days: next.map((day) => {
        const old = original.schedule.days.find((prior) => prior.day === day.day);
        return old && (old as any).meta?.pinned ? old : day;
      }) };
    }
    const validated = KitSchema.parse(updated);
    await KitModel.updateOne({ _id: record._id }, { kit: validated });
    return res.json({ kit: validated });
  } catch (error) {
    return res.status(502).json({ code: "REGENERATION_FAILED", message: error instanceof Error ? error.message : "Unable to regenerate this section." });
  }
}));
app.delete("/api/kits/:id", authenticate, asyncHandler<AuthedRequest>(async (req, res) => {
  const deleted = await KitModel.findOneAndDelete({ _id: req.params.id, owner_id: req.userId });
  return deleted ? res.status(204).end() : res.status(404).json({ code: "NOT_FOUND", message: "Kit not found." });
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(500).json({ code: "INTERNAL_ERROR", message: "An unexpected server error occurred." });
});
await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/ai-interview-prep-kit");
const interrupted = await KitModel.find({ status: "running" });
for (const record of interrupted) void runGeneration(record, String(record.get("jd")), String(record.get("company_url")), Number(record.get("days")));
app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
