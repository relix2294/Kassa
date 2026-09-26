import { useRef, useState } from 'react';
import { api } from '../api';
import { pullProducts } from '../sync';

// Выгрузка/загрузка каталога товаров.
// Смысл: ваша ручная база местных штрихкодов + названий + цен — это ценность,
// которой нет ни в одной внешней базе. Её нужно уметь сохранить файлом
// (резервная копия) и развернуть в новом магазине (та же продукция, свой остаток).

// Простой парсер CSV: понимает кавычки, запятые/точки с запятой и переводы строк.
function parseCSV(raw: string): Record<string, string>[] {
  const text = raw.replace(/^﻿/, '');
  const firstLine = text.slice(0, text.search(/\r?\n/) >= 0 ? text.search(/\r?\n/) : text.length);
  // Excel в ru-локали часто сохраняет с ';'. Определяем разделитель по заголовку.
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { cur.push(field); field = ''; }
    else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
    else if (c === '\r') { /* пропускаем */ }
    else field += c;
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows
    .slice(1)
    .filter((r) => r.some((x) => x.trim() !== ''))
    .map((r) => {
      const o: Record<string, string> = {};
      header.forEach((h, idx) => (o[h] = (r[idx] ?? '').trim()));
      return o;
    });
}

export default function CatalogPanel({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function download() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const csv = await api.exportCatalog();
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kassa-catalog-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMsg('Каталог скачан. Сохрани файл как резервную копию (флешка, облако).');
    } catch (e: any) {
      setErr(e.message || 'Не удалось скачать');
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const rows = parseCSV(await file.text());
      if (rows.length === 0) {
        setErr('В файле не нашлось строк с товарами');
        return;
      }
      const products = rows.map((r) => ({
        barcode: r.barcode,
        name: r.name,
        category: r.category,
        unit: r.unit,
        sale_price: r.sale_price,
        cost_price: r.cost_price,
        min_stock: r.min_stock,
      }));
      const res = await api.importCatalog(products);
      await pullProducts();
      setMsg(`Готово. Добавлено: ${res.added}, пропущено (уже были): ${res.skipped}.`);
      onDone('Каталог загружен');
    } catch (e: any) {
      setErr(e.message || 'Не удалось загрузить каталог');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Каталог товаров</h2>
        <p className="muted">
          Сохрани всю базу товаров файлом или перенеси её в другой магазин.
          Остаток не переносится — в новом магазине у товара будет свой.
        </p>

        <div className="card" style={{ marginBottom: 12 }}>
          <div className="product-name">📤 Сохранить каталог</div>
          <p className="hint">Скачает CSV со всеми товарами (штрихкод, название, категория, цены). Открывается в Excel.</p>
          <button className="btn btn--primary" onClick={download} disabled={busy}>
            Скачать CSV
          </button>
        </div>

        <div className="card">
          <div className="product-name">📥 Загрузить каталог</div>
          <p className="hint">
            Добавит товары из файла. Уже существующие (по штрихкоду или названию) не трогаются —
            цены не перезапишутся. Идеально для второго магазина.
          </p>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} disabled={busy} />
        </div>

        {msg && <div style={{ marginTop: 12, color: '#16a34a', fontWeight: 600 }}>{msg}</div>}
        {err && <div style={{ marginTop: 12, color: 'var(--danger)', fontWeight: 600 }}>{err}</div>}

        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={onClose} disabled={busy}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
