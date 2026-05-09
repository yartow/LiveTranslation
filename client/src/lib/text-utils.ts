/** Counts sentence-ending punctuation marks in a string. */
export function countSentences(text: string): number {
  if (!text.trim()) return 0;
  return (text.match(/[.!?]+/g) || []).length;
}
