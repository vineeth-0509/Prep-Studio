import type { Kit, Question, Requirement } from "./kit-schema.js";

export function checkCoverage(requirements: Requirement[], questions: Question[]): Kit["coverage"] {
  const covered = new Set(questions.flatMap((question) => question.requirement_ids));
  return {
    uncovered_requirement_ids: requirements.filter(({ id }) => !covered.has(id)).map(({ id }) => id),
    passes: 1,
  };
}

