/**
 * Guarded parse of a model's JSON reply: pulls the outermost {...} out of
 * the text (local and hosted models alike sometimes wrap the object in
 * prose or a markdown fence) and degrades to `fallback` instead of
 * throwing out of a request handler.
 */
export function parseJsonResponse(
  raw: string,
  fallback: Record<string, string>,
): Record<string, string> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]);
  } catch {
    return fallback;
  }
}
