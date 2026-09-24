import { z } from "zod";

const ItemMetaSchema = z
  .object({
    source: z.enum(["generated", "user_edited", "user_created"]),
    pinned: z.boolean(),
    version: z.number().int().nonnegative(),
  })
  .passthrough();

const SourceSchema = z
  .object({
    company: z.string(),
    company_url: z.string(),
    role: z.string(),
    location: z.string(),
    jd_chars: z.number().int().nonnegative(),
    researched_at: z.string(),
    pages_used: z.array(z.string()),
  })
  .passthrough();

const CompanyBriefSchema = z
  .object({
    summary: z.string(),
    what_they_do: z.string(),
    sources: z.array(z.string()),
    meta: ItemMetaSchema.optional(),
  })
  .passthrough();

export const RequirementSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    kind: z.enum(["technical", "behavioural", "domain"]),
    priority: z.enum(["must", "nice"]),
    meta: ItemMetaSchema.optional(),
  })
  .passthrough();

const RoleSchema = z
  .object({
    title: z.string(),
    seniority: z.string(),
    responsibilities: z.array(z.string()),
    requirements: z.array(RequirementSchema),
  })
  .passthrough();

export const QuestionSchema = z
  .object({
    id: z.string().min(1),
    requirement_ids: z.array(z.string()),
    category: z.enum(["technical", "behavioural", "system-design", "company-fit"]),
    prompt: z.string(),
    answer_outline: z.string(),
    difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    meta: ItemMetaSchema.optional(),
  })
  .passthrough();

export const FlashcardSchema = z
  .object({
    id: z.string().min(1),
    front: z.string(),
    back: z.string(),
    requirement_ids: z.array(z.string()),
    confidence: z.number().int().min(1).max(5).optional(),
    meta: ItemMetaSchema.optional(),
  })
  .passthrough();

const ScheduleDaySchema = z
  .object({
    day: z.number().int().positive(),
    focus: z.string(),
    question_ids: z.array(z.string()),
    minutes: z.number().int().nonnegative(),
    meta: ItemMetaSchema.optional(),
  })
  .passthrough();

const ScheduleSchema = z
  .object({
    days_available: z.number().int().positive(),
    days: z.array(ScheduleDaySchema),
  })
  .passthrough();

const CoverageSchema = z
  .object({
    uncovered_requirement_ids: z.array(z.string()),
    passes: z.number().int().min(1).max(2),
  })
  .passthrough();

/** Appendix A kit shape, with cross-reference checks that make coverage auditable. */
export const KitSchema = z
  .object({
    source: SourceSchema,
    company_brief: CompanyBriefSchema,
    role: RoleSchema,
    questions: z.array(QuestionSchema),
    flashcards: z.array(FlashcardSchema),
    schedule: ScheduleSchema,
    coverage: CoverageSchema,
  })
  .passthrough()
  .superRefine((kit, context) => {
    const requirementIds = new Set(kit.role.requirements.map(({ id }) => id));
    const questionIds = new Set(kit.questions.map(({ id }) => id));
    const checkUnique = (values: string[], path: Array<string | number>, label: string) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, index], message: `Duplicate ${label} id: ${value}` });
        seen.add(value);
      });
    };
    checkUnique(kit.role.requirements.map(({ id }) => id), ["role", "requirements"], "requirement");
    checkUnique(kit.questions.map(({ id }) => id), ["questions"], "question");
    checkUnique(kit.flashcards.map(({ id }) => id), ["flashcards"], "flashcard");
    checkUnique(kit.schedule.days.map(({ day }) => String(day)), ["schedule", "days"], "schedule day");
    if (kit.schedule.days.length !== kit.schedule.days_available) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule", "days"], message: "Schedule must contain exactly days_available entries" });
    }
    kit.schedule.days.forEach((day, index) => {
      if (day.day !== index + 1) context.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule", "days", index, "day"], message: "Schedule day numbers must run from 1 through days_available" });
    });

    kit.questions.forEach((question, questionIndex) => {
      question.requirement_ids.forEach((requirementId, referenceIndex) => {
        if (!requirementIds.has(requirementId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["questions", questionIndex, "requirement_ids", referenceIndex],
            message: `Unknown requirement id: ${requirementId}`,
          });
        }
      });
    });

    kit.flashcards.forEach((flashcard, flashcardIndex) => {
      flashcard.requirement_ids.forEach((requirementId, referenceIndex) => {
        if (!requirementIds.has(requirementId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["flashcards", flashcardIndex, "requirement_ids", referenceIndex],
            message: `Unknown requirement id: ${requirementId}`,
          });
        }
      });
    });

    kit.schedule.days.forEach((day, dayIndex) => {
      day.question_ids.forEach((questionId, referenceIndex) => {
        if (!questionIds.has(questionId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["schedule", "days", dayIndex, "question_ids", referenceIndex],
            message: `Unknown question id: ${questionId}`,
          });
        }
      });
    });

    kit.coverage.uncovered_requirement_ids.forEach((requirementId, index) => {
      if (!requirementIds.has(requirementId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["coverage", "uncovered_requirement_ids", index], message: `Unknown requirement id: ${requirementId}` });
    });
  });

export type Kit = z.infer<typeof KitSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Flashcard = z.infer<typeof FlashcardSchema>;

/** Parse and validate an Appendix A kit, preserving any legitimate additive fields. */
export function validateKit(input: unknown): Kit {
  return KitSchema.parse(input);
}
