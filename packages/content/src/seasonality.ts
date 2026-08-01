import { ContentValidationError } from "./errors";
import type { SeasonalityResult, SeasonalityRule, SeasonalSubjectRef } from "./model";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function evaluateSeasonality(
  rules: readonly SeasonalityRule[],
  subjectRef: SeasonalSubjectRef,
  regionId: string,
  localDate: string,
): SeasonalityResult {
  if (!validDate(localDate)) throw new ContentValidationError([{ code: "SEASONALITY_UNRESOLVED", path: "$.localDate", message: "Service local date must be a real ISO-8601 Gregorian date." }]);
  const matching = rules.filter((rule) => rule.subjectRef.kind === subjectRef.kind && rule.subjectRef.id === subjectRef.id && rule.subjectRef.version === subjectRef.version && rule.regionId === regionId);
  if (matching.length === 0) return "unspecified";
  const active = matching.flatMap((rule) => rule.windows.filter((window) => window.startLocalDateInclusive <= localDate && localDate < window.endLocalDateExclusive));
  if (new Set(active.map((window) => window.availability)).size > 1) throw new ContentValidationError([{ code: "SEASONALITY_UNRESOLVED", path: "$.rules", message: "Matching seasonality rules contradict one another." }]);
  return active[0]?.availability ?? "unavailable";
}
