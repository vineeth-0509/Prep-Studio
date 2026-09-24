import test from "node:test";
import assert from "node:assert/strict";
import { buildSchedule, checkCoverage, classifyPriority, KitSchema, type Question, type Requirement } from "./index.js";

const reqs: Requirement[] = [
  { id: "r1", text: "API design", kind: "technical", priority: "must" },
  { id: "r2", text: "Mentoring", kind: "behavioural", priority: "nice" },
];
const qs: Question[] = [
  { id: "q1", requirement_ids: ["r1"], category: "system-design", prompt: "Design an API", answer_outline: "Tradeoffs", difficulty: 3 },
  { id: "q2", requirement_ids: ["r2"], category: "behavioural", prompt: "Mentoring example?", answer_outline: "STAR", difficulty: 1 },
];

test("scheduler returns every requested day and schedules all questions", () => {
  for (const count of [1, 5, 60]) {
    const schedule = buildSchedule(reqs, qs, count);
    assert.equal(schedule.days.length, count);
    assert.ok(schedule.days.every((day) => Number.isInteger(day.minutes)));
    assert.ok(schedule.days.some((day) => day.question_ids.includes("q1")));
    assert.ok(schedule.days.every((day) => day.question_ids.length > 0));
    assert.ok(schedule.days[0]!.question_ids.includes("q1"));
  }
  const niceOnly = buildSchedule([{ ...reqs[1]!, id: "r-only" }], [{ ...qs[1]!, id: "q-only", requirement_ids: ["r-only"] }], 60);
  assert.ok(niceOnly.days.every((day) => day.question_ids.length > 0));
});

test("coverage checker reports uncovered requirement ids", () => {
  assert.deepEqual(checkCoverage(reqs, [qs[0]!]).uncovered_requirement_ids, ["r2"]);
  assert.deepEqual(checkCoverage([], []).uncovered_requirement_ids, []);
});

test("priority classifier honors wording and defaults ambiguity to nice", () => {
  assert.equal(classifyPriority("5+ years of React required"), "must");
  assert.equal(classifyPriority("5 years of React"), "must");
  assert.equal(classifyPriority("Experience is not required"), "nice");
  assert.equal(classifyPriority("Bonus points for GraphQL"), "nice");
  assert.equal(classifyPriority("Experience with cloud platforms"), "nice");
});

test("Appendix A schema validates a complete kit and rejects broken references", () => {
  const kit = {
    source: { company: "Acme", company_url: "https://acme.test", role: "Engineer", location: "", jd_chars: 10, researched_at: new Date().toISOString(), pages_used: [] },
    company_brief: { summary: "Acme", what_they_do: "Software", sources: [] },
    role: { title: "Engineer", seniority: "Senior", responsibilities: [], requirements: reqs },
    questions: qs, flashcards: [], schedule: buildSchedule(reqs, qs, 2), coverage: checkCoverage(reqs, qs),
  };
  assert.equal(KitSchema.safeParse(kit).success, true);
  const bad = structuredClone(kit);
  bad.questions[0]!.requirement_ids = ["missing"];
  assert.equal(KitSchema.safeParse(bad).success, false);
  const wrongDays = structuredClone(kit);
  wrongDays.schedule.days.pop();
  assert.equal(KitSchema.safeParse(wrongDays).success, false);
  const decimalMinutes = structuredClone(kit);
  decimalMinutes.schedule.days[0]!.minutes = 4.5;
  assert.equal(KitSchema.safeParse(decimalMinutes).success, false);
});
