// Minimal RFC4180 CSV tokenizer — no dependency. Handles quoted fields
// (including embedded commas/newlines), "" as an escaped quote, CRLF/LF line
// endings, and a leading UTF-8 BOM. Returns raw rows of raw fields; it does
// not know about headers, column counts, or malformed rows — that repair
// logic is domain-specific and lives in glossary-parse.ts, which is why this
// file stays a generic, independently testable tokenizer.

export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = src.length;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < n) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }

    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ',') { endField(); i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { endRow(); i += 1; continue; }
    field += c; i += 1;
  }

  // Trailing content with no final newline — flush unless the file ended
  // cleanly on a newline (in which case field/row are already empty).
  if (field.length > 0 || row.length > 0) endRow();

  return rows;
}
