/**
 * RFC 4180 CSV writer.
 *
 * The counterpart to the hand-written reader: a field is quoted when it holds
 * a delimiter, a quote or a newline, and a quote inside is doubled. CRLF
 * because these files are opened in Excel more often than anything else, and
 * every reader accepts it.
 */
export function toCsv(
  columns: readonly string[],
  rows: readonly Record<string, string | number>[],
): string {
  const lines = [columns.map(quote).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => quote(row[c] ?? "")).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function quote(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
