import { describe, it, expect } from 'vitest';
import { parseCsv } from '../../server/lib/csv-parse.js';

describe('parseCsv', () => {
  it('parses plain unquoted rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('handles quoted fields containing commas', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']]);
  });

  it('handles "" as an escaped quote inside a quoted field', () => {
    expect(parseCsv('a,"she said ""hi""",c')).toEqual([['a', 'she said "hi"', 'c']]);
  });

  it('handles an embedded newline inside a quoted field', () => {
    expect(parseCsv('a,"line1\nline2",c')).toEqual([['a', 'line1\nline2', 'c']]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('does not hang on an unterminated quote', () => {
    expect(parseCsv('a,"unterminated')).toEqual([['a', 'unterminated']]);
  });

  it('does not emit a trailing empty row after a final newline', () => {
    expect(parseCsv('a,b\nc,d\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('preserves an empty trailing field', () => {
    expect(parseCsv('a,b,')).toEqual([['a', 'b', '']]);
  });
});
