// Генерация читаемого .xlsx на клиенте: заголовок отчёта, жирные цветные
// шапки, ширина колонок по содержимому, числовой формат (разделители тысяч),
// числа — настоящими числами (а не текстом, как было в CSV). Несколько таблиц
// складываются на один лист с подписями.

export interface XlsxCol { header: string; num?: boolean; pct?: boolean; }
export interface XlsxSection { caption?: string; columns: XlsxCol[]; rows: (string | number)[][]; }

const ACCENT = 'FF6D6CFF';      // индиго — как в приложении
const HEADER_TEXT = 'FFFFFFFF';

export async function exportXlsx(filename: string, title: string, sections: XlsxSection[]) {
  // Динамический импорт: тяжёлый ExcelJS грузится только при выгрузке
  // (владельцем), не попадает в основной бандл кассы.
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kassa';
  wb.created = new Date();
  const ws = wb.addWorksheet('Отчёт');

  const widths: number[] = [];
  const track = (i: number, len: number) => { widths[i] = Math.max(widths[i] ?? 10, Math.min(len + 2, 50)); };

  const titleRow = ws.addRow([title]);
  titleRow.font = { bold: true, size: 14, color: { argb: ACCENT } };
  track(0, title.length);
  ws.addRow([]);

  for (const sec of sections) {
    if (sec.caption) {
      const cap = ws.addRow([sec.caption]);
      cap.font = { bold: true, size: 12 };
      track(0, sec.caption.length);
    }
    const header = ws.addRow(sec.columns.map((c) => c.header));
    header.height = 20;
    header.eachCell((cell, col) => {
      const def = sec.columns[col - 1];
      cell.font = { bold: true, color: { argb: HEADER_TEXT } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT } };
      cell.alignment = { horizontal: def?.num || def?.pct ? 'right' : 'left', vertical: 'middle' };
      track(col - 1, def.header.length);
    });

    for (const r of sec.rows) {
      const row = ws.addRow(r);
      row.eachCell((cell, col) => {
        const def = sec.columns[col - 1];
        const v = r[col - 1];
        if (def?.num && typeof v === 'number') {
          cell.numFmt = '#,##0.##';
          cell.alignment = { horizontal: 'right' };
        } else if (def?.pct && typeof v === 'number') {
          cell.numFmt = '0.0"%"';
          cell.alignment = { horizontal: 'right' };
        }
        track(col - 1, String(v ?? '').length);
      });
    }
    ws.addRow([]);
  }

  for (let i = 0; i < widths.length; i++) ws.getColumn(i + 1).width = widths[i] ?? 12;

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(a.href);
}
