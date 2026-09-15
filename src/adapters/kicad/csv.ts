/**
 * RFC 4180 CSV reader.
 *
 * Written rather than pulled in because the reference-designator column is full
 * of embedded commas (`"C1001,C2004,C6001-C6004"`), so a naive split destroys
 * the data — and because the file may arrive with CRLF, LF, or a BOM.
 */
export function parseCsv(input: string, delimiter = ","): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  let sawField = false;

  const endField = (): void => {
    row.push(field);
    field = "";
    sawField = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i] as string;

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && !sawField) {
      quoted = true;
      sawField = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += text[i + 1] === "\n" ? 2 : 1;
      endRow();
      continue;
    }
    if (ch === "\n") {
      i += 1;
      endRow();
      continue;
    }

    field += ch;
    sawField = true;
    i += 1;
  }

  // A trailing newline must not produce a phantom row.
  if (field !== "" || row.length > 0) endRow();

  return rows;
}

/** Rows keyed by header name, with the header row consumed. */
export function parseCsvRecords(input: string, delimiter = ","): Record<string, string>[] {
  const rows = parseCsv(input, delimiter);
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.some((cell) => cell.trim() !== ""))
    .map((r) => {
      const record: Record<string, string> = {};
      header.forEach((name, idx) => {
        record[name] = r[idx] ?? "";
      });
      return record;
    });
}
