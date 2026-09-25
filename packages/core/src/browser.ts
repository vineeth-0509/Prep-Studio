// Browser-safe exports for the web app. Keep server-only modules such as the
// research pipeline out of this entry point so client bundles never traverse
// Node built-ins (for example node:net).
export { FlashcardSchema, KitSchema, QuestionSchema, RequirementSchema, validateKit } from "./kit-schema.js";
export type { Flashcard, Kit, Question, Requirement } from "./kit-schema.js";
export { buildSchedule, MINUTES_BY_DIFFICULTY } from "./schedule.js";
export { checkCoverage } from "./coverage.js";
export { classifyPriority } from "./priority.js";
