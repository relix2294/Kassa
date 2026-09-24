import { useEffect, useMemo, useState } from 'react';
import NumberInput from '../components/NumberInput';
import { api, type ImportResult } from '../api';
import { db } from '../db';
import { pullProducts } from '../sync';
import { barcodeVariants } from '../scan';
import {
  FIELDS,
  FIELD_LABELS,
  detectTable,
  readTable,
  toImportRows,
  type Field,
  type Mapping,
} from '../importFile';

// Загрузка прайса или накладной поставщика: сотни товаров за минуту
// вместо ручного набора. Владелец видит, что распозналось, и может
// поправить колонки до загрузки.

const CHUNK = 2000;

export default function ImportPanel({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [fileName, setFileName] = useState('');
  const [table, setTable] = useState<string[][] | null>(null);
  const [headerRow, setHeaderRow] = useState(-1);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [receive, setReceive] = useState(false);
  const [updatePrices, setUpdatePrices] = useState(false);
  const [markup, setMarkup] = useState('30');
  const [category, setCategory] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [existing, setExisting] = useState(0);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setErr(null);
    setResult(null);
    try {
      const rows = await readTable(file);
      const d = detectTable(rows);
      setFileName(file.name);
      setTable(rows);
      setHeaderRow(d.headerRow);
      setMapping(d.mapping);
      // Есть колонка количества — похоже на накладную: сразу предлагаем оприходовать.
      setReceive(d.mapping.qty !== -1);
    } catch (e: any) {
      setErr(e.message || 'Не удалось прочитать файл');
    }
  }

  const rows = useMemo(
    () => (table && mapping ? toImportRows(table, headerRow, mapping) : []),
    [table, headerRow, mapping],
  );

  // Сколько товаров из файла уже заведено — их не будут создавать заново.
  useEffect(() => {
    const codes = rows.flatMap((r) => (r.barcode ? barcodeVariants(r.barcode) : []));
    if (codes.length === 0) {
      setExisting(0);
      return;
    }
    db.products
      .where('barcode')
      .anyOf(codes)
      .count()
      .then(setExisting)
      .catch(() => setExisting(0));
  }, [rows]);

  function setCol(f: Field, col: number) {
    setMapping((m) => (m ? { ...m, [f]: col } : m));
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    const total: ImportResult = { created: 0, prices_updated: 0, received: 0, skipped: [], warnings: [] };
    try {
      // Большой файл шлём частями: каждая часть принимается целиком или никак.
      for (let i = 0; i < rows.length; i += CHUNK) {
        setProgress(rows.length > CHUNK ? `${Math.min(i + CHUNK, rows.length)} из ${rows.length}…` : '');
        const r = await api.importProducts({
          rows: rows.slice(i, i + CHUNK),
          markup: Number(markup) || 0,
          receive,
          update_prices: updatePrices,
          category: category.trim() || undefined,
        });
        total.created += r.created;
        total.prices_updated += r.prices_updated;
        total.received += r.received;
        total.skipped.push(...r.skipped);
        total.warnings.push(...r.warnings);
      }
      await pullProducts();
      setResult(total);
    } catch (e: any) {
      setErr(`${e.message || 'Ошибка загрузки'}${total.created ? ` (часть файла уже загружена: заведено ${total.created})` : ''}`);
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  if (result) {
    return (
      <div className="modal-backdrop" onClick={() => onDone('Прайс загружен')}>
        <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
          <h2>Готово</h2>
          <div className="import-stats">
            <div><b>{result.created}</b> заведено новых</div>
            {receive && <div><b>{result.received}</b> оприходовано</div>}
            {updatePrices && <div><b>{result.prices_updated}</b> цен обновлено</div>}
            {result.skipped.length > 0 && <div><b>{result.skipped.length}</b> пропущено</div>}
          </div>
          {result.warnings.length > 0 && (
            <div className="warn">
              <b>Без цены продажи ({result.warnings.length}):</b>
              <ul className="import-issues">
                {result.warnings.slice(0, 30).map((w) => <li key={w.line}>строка {w.line}: {w.text}</li>)}
              </ul>
            </div>
          )}
          {result.skipped.length > 0 && (
            <ul className="import-issues">
              {result.skipped.slice(0, 50).map((s) => <li key={s.line}>строка {s.line}: {s.reason}</li>)}
            </ul>
          )}
          <button className="btn btn--primary" onClick={() => onDone('Прайс загружен')}>
            Закрыть
          </button>
        </div>
      </div>
    );
  }

  const header = table && headerRow >= 0 ? table[headerRow] : null;
  const width = table ? Math.max(0, ...table.slice(0, 50).map((r) => r.length)) : 0;
  const colName = (i: number) => (header?.[i]?.trim() ? header[i].trim() : `Колонка ${i + 1}`);
  const canSubmit = rows.length > 0 && mapping && (mapping.barcode !== -1 || mapping.name !== -1) && !busy;

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <h2>Загрузить прайс или накладную</h2>
        <p className="muted">
          Файл Excel (.xlsx) или CSV от поставщика: штрихкод, название, цена. Уже заведённые товары
          не создаются заново.
        </p>

        <label className="btn import-file">
          {fileName || 'Выбрать файл…'}
          <input type="file" accept=".xlsx,.csv,.txt,.xls" onChange={(e) => onFile(e.target.files?.[0])} hidden />
        </label>

        {err && <div className="change change--neg">{err}</div>}

        {table && mapping && (
          <>
            <div className="import-map">
              {FIELDS.map((f) => (
                <label key={f} className="field">
                  <span>{FIELD_LABELS[f]}</span>
                  <select value={mapping[f]} onChange={(e) => setCol(f, Number(e.target.value))}>
                    <option value={-1}>— нет —</option>
                    {Array.from({ length: width }, (_, i) => (
                      <option key={i} value={i}>{colName(i)}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>

            <p className="hint">
              Товаров в файле: <b>{rows.length}</b>
              {existing > 0 && <> · уже заведено: <b>{existing}</b></>}
              {mapping.name === -1 && ' · названий нет — возьмём из справочника штрихкодов, где найдутся'}
            </p>

            <div className="import-preview">
              <table>
                <thead>
                  <tr>
                    {FIELDS.filter((f) => mapping[f] !== -1).map((f) => <th key={f}>{FIELD_LABELS[f]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 8).map((r) => (
                    <tr key={r.line}>
                      {FIELDS.filter((f) => mapping[f] !== -1).map((f) => <td key={f}>{String(r[f] ?? '')}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <label className="check">
              <input type="checkbox" checked={receive} onChange={(e) => setReceive(e.target.checked)} />
              Это накладная — оприходовать количество на склад
            </label>
            <label className="check">
              <input type="checkbox" checked={updatePrices} onChange={(e) => setUpdatePrices(e.target.checked)} />
              Обновить цену продажи у уже заведённых товаров
            </label>

            <div className="row">
              {mapping.sale_price === -1 && (
                <label className="field">
                  <span>Наценка на закупочную, %</span>
                  <NumberInput value={markup} onValue={setMarkup} />
                </label>
              )}
              <label className="field">
                <span>Категория, если в файле нет</span>
                <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="напр. Напитки" />
              </label>
            </div>
          </>
        )}

        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={!canSubmit}>
            {busy ? progress || 'Загружаем…' : `Загрузить ${rows.length || ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
