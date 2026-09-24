/** Applies the posting's surrounding language; ambiguous extracted lines default to nice. */
export function classifyPriority(text: string, context = text): "must" | "nice" {
  const normalized = `${context}\n${text}`.toLowerCase();
  if (/\b(not required|not mandatory|not necessary|bonus points|nice to have|preferred|preferably|desirable|a plus|optional)\b/.test(normalized)) return "nice";
  if (/\b(required|required qualification|must[- ]have|must|required to|minimum of|at least\s+\d+\s+years?|\d+\s+years?\s+(?:of|in|with)|\d+\+\s+years?)\b/.test(normalized)) return "must";
  return "nice";
}
