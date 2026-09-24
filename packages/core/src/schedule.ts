import type { Kit, Question, Requirement } from "./kit-schema.js";

export const MINUTES_BY_DIFFICULTY = { 1: 10, 2: 15, 3: 25 } as const;

/** Deterministically packs questions, prioritizing must-have and harder topics early. */
export function buildSchedule(
  requirements: Requirement[],
  questions: Question[],
  daysAvailable: number,
): Kit["schedule"] {
  if (!Number.isInteger(daysAvailable) || daysAvailable < 1) {
    throw new RangeError("daysAvailable must be a positive integer");
  }
  const priorities = new Map(requirements.map((requirement) => [requirement.id, requirement.priority]));
  const ranked = [...questions].sort((a, b) => {
    const ap = Math.min(...a.requirement_ids.map((id) => priorities.get(id) === "must" ? 0 : 1), 1);
    const bp = Math.min(...b.requirement_ids.map((id) => priorities.get(id) === "must" ? 0 : 1), 1);
    return ap - bp || b.difficulty - a.difficulty || a.id.localeCompare(b.id);
  });

  // Allocate questions to the least-loaded day, with a small early-day weight to front-load work.
  const days = Array.from({ length: daysAvailable }, (_, index) => ({
    day: index + 1,
    focus: "Review and practice",
    question_ids: [] as string[],
    minutes: 0,
  }));
  for (const question of ranked) {
    const selected = days.reduce((best, day, index, all) => {
      const score = day.minutes + index * 2;
      const bestScore = best.minutes + all.indexOf(best) * 2;
      return score < bestScore ? day : best;
    });
    selected.question_ids.push(question.id);
    selected.minutes += MINUTES_BY_DIFFICULTY[question.difficulty];
  }

  // Long preparation windows still have a concrete review task every day.
  const reviewQuestion = ranked.find((question) => question.requirement_ids.some((id) => priorities.get(id) === "must")) ?? ranked[0];
  if (reviewQuestion) {
    for (const day of days) {
      if (day.question_ids.length === 0) {
        day.question_ids.push(reviewQuestion.id);
        day.minutes = MINUTES_BY_DIFFICULTY[reviewQuestion.difficulty];
      }
    }
  }

  for (const day of days) {
    const assigned = day.question_ids.map((id) => questions.find((question) => question.id === id)!);
    if (assigned.length) {
      const counts = new Map<string, number>();
      assigned.forEach((question) => counts.set(question.category, (counts.get(question.category) ?? 0) + 1));
      const focusCategory = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
      day.focus = focusCategory ? `Practice ${focusCategory} questions` : day.focus;
    }
  }
    return { days_available: daysAvailable, days };
}
