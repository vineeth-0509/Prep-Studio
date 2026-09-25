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

  // Seed Day 1 with one question from each available category so practice starts broad.
  const assigned = new Set<string>();
  const firstDay = days[0]!;
  for (const category of ["company-fit", "behavioural", "technical", "system-design"] as const) {
    const question = ranked.find((item) => item.category === category && !assigned.has(item.id));
    if (!question) continue;
    firstDay.question_ids.push(question.id);
    firstDay.minutes += MINUTES_BY_DIFFICULTY[question.difficulty];
    assigned.add(question.id);
  }

  for (const question of ranked) {
    if (assigned.has(question.id)) continue;
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
      const categoryLabels: Record<Question["category"], string> = {
        "company-fit": "Company fit",
        behavioural: "Behavioural (STAR)",
        technical: "Technical",
        "system-design": "System design",
      };
      const topics = new Map<Question["category"], string[]>();
      for (const question of assigned) {
        const entries = topics.get(question.category) ?? [];
        const requirementTopics = question.requirement_ids
          .map((id) => requirements.find((requirement) => requirement.id === id)?.text)
          .filter((value): value is string => Boolean(value));
        const rawTopics = requirementTopics.length ? requirementTopics : [question.category === "company-fit" ? "role motivation, products, and customers" : question.prompt];
        for (const raw of rawTopics) {
          const phrases = raw
            .replace(/^(experience|knowledge|proficiency|familiarity|understanding)\s+(with|of|in)\s+/i, "")
            .split(/[;,.]|\band\b|\bincluding\b/)
            .map((part) => part.trim().replace(/^(and|or)\s+/i, ""))
            .filter(Boolean)
            .slice(0, 3)
            .map((part) => part.split(/\s+/).slice(0, 4).join(" "));
          for (const phrase of phrases) {
            if (!entries.some((existing) => existing.toLowerCase() === phrase.toLowerCase())) entries.push(phrase);
            if (entries.length >= 3) break;
          }
          if (entries.length >= 3) break;
        }
        topics.set(question.category, entries);
      }
      const order: Question["category"][] = ["company-fit", "behavioural", "technical", "system-design"];
      day.focus = order
        .filter((category) => topics.has(category))
        .map((category) => `${categoryLabels[category]}: ${(topics.get(category) ?? []).join(", ")}`)
        .join(" · ");
    }
  }
    return { days_available: daysAvailable, days };
}
