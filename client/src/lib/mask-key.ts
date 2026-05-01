/** Returns a masked preview: first 6 chars + bullets + last 4 chars. */
export function maskKey(key: string): string {
  if (key.length <= 10) return '•'.repeat(key.length);
  return key.slice(0, 6) + '•'.repeat(key.length - 10) + key.slice(-4);
}
