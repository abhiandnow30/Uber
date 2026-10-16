import ExcelJS from 'exceljs';

/**
 * Neutralise spreadsheet formula injection (CSV injection): any cell starting with
 * = + - @ TAB or CR is prefixed with a single quote so Excel treats it as text.
 */
export function neutralizeFormula(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function csvCell(value: unknown) {
  const s = neutralizeFormula(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  // BOM so Excel opens UTF-8 correctly.
  return '﻿' + [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export async function toXlsx(sheetName: string, headers: string[], rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Employee Cab Booking';
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.addRow(headers).font = { bold: true };
  for (const r of rows) {
    // Strings are written as literal text cells (never formulas); neutralise anyway
    // in case the file is later re-saved as CSV.
    ws.addRow(r.map((v) => (typeof v === 'number' ? v : neutralizeFormula(v))));
  }
  ws.columns.forEach((c) => (c.width = 20));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
