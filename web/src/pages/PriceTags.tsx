import { useEffect, useMemo, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { db } from '../db';
import { api } from '../api';
import { pullProducts } from '../sync';
import type { Product } from '../types';

// Печать ценников со штрих-кодом. Штучному печатаем его штрих-код; товару без
// штрих-кода можно присвоить внутренний код — и он станет сканируемым.
export default function PriceTags() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const products = useLiveQuery(() => db.products.orderBy('name').toArray(), [], [] as Product[]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = products.filter((p) => !p.is_archived);
    if (!s) return list;
    return list.filter(
      (p) => p.name.toLowerCase().includes(s) || (p.category ?? '').toLowerCase().includes(s) || (p.barcode ?? '').includes(s),
    );
  }, [products, q]);

  const chosen = filtered.filter((p) => sel.has(p.id));
  const chosenNoBarcode = chosen.filter((p) => !p.barcode);

  function toggle(id: string) {
    setSel((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  function selectAllShown() { setSel(new Set(filtered.map((p) => p.id))); }
  function clearSel() { setSel(new Set()); }

  // Присвоить внутренние штрих-коды выбранным товарам без него.
  async function assignCodes() {
    setBusy(true);
    setMsg(null);
    try {
      for (const p of chosenNoBarcode) await api.assignBarcode(p.id);
      await pullProducts();
      setMsg(`Присвоено кодов: ${chosenNoBarcode.length}`);
    } catch (e: any) {
      setMsg(e.message || 'Не удалось присвоить коды');
    } finally {
      setBusy(false);
    }
  }

  const readyToPrint = chosen.filter((p) => !!p.barcode);

  return (
    <div className="page">
      <div className="sale-head no-print">
        <h1>Ценники</h1>
        <Link className="btn btn--ghost" to="/products">← к товарам</Link>
      </div>

      <div className="no-print">
        <input className="search" placeholder="Поиск по названию, категории, штрихкоду" value={q} onChange={(e) => setQ(e.target.value)} />

        <div className="row" style={{ margin: '8px 0' }}>
          <button className="btn btn--ghost" onClick={selectAllShown}>Выбрать всё ({filtered.length})</button>
          <button className="btn btn--ghost" onClick={clearSel}>Снять выбор</button>
        </div>

        <p className="hint">Выбрано: {chosen.length}. Без штрих-кода среди выбранных: {chosenNoBarcode.length}.</p>

        {chosenNoBarcode.length > 0 && (
          <button className="btn" onClick={assignCodes} disabled={busy}>
            Присвоить внутренние коды ({chosenNoBarcode.length})
          </button>
        )}

        {msg && <div style={{ margin: '8px 0', color: '#16a34a', fontWeight: 600 }}>{msg}</div>}

        <div className="list" style={{ marginTop: 8, maxHeight: 320, overflowY: 'auto' }}>
          {filtered.slice(0, 200).map((p) => (
            <label key={p.id} className="list-item" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} style={{ marginRight: 10 }} />
              <div className="list-item__main">
                <div className="list-item__name">{p.name}</div>
                <div className="muted">{p.barcode || 'без штрих-кода'}{p.category ? ` · ${p.category}` : ''}</div>
              </div>
              <div className="stock">{p.sale_price}{p.unit === 'kg' ? ' /кг' : ''}</div>
            </label>
          ))}
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn--primary btn--big" disabled={readyToPrint.length === 0} onClick={() => window.print()}>
            🖨️ Печать ценников ({readyToPrint.length})
          </button>
        </div>
        {chosen.length > readyToPrint.length && (
          <p className="hint">У {chosen.length - readyToPrint.length} выбранных нет штрих-кода — присвойте коды, иначе они не попадут в печать.</p>
        )}
      </div>

      {/* Область печати — только ценники с штрих-кодом. */}
      <div className="tags-print">
        {readyToPrint.map((p) => (
          <Tag key={p.id} product={p} />
        ))}
      </div>
    </div>
  );
}

function Tag({ product }: { product: Product }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current || !product.barcode) return;
    try {
      JsBarcode(ref.current, product.barcode, {
        format: 'CODE128',
        width: 1.6,
        height: 38,
        fontSize: 12,
        margin: 2,
        displayValue: true,
      });
    } catch {
      /* ignore */
    }
  }, [product.barcode]);

  return (
    <div className="tag">
      <div className="tag__name">{product.name}</div>
      <div className="tag__price">
        {product.sale_price}
        <span className="tag__unit">{product.unit === 'kg' ? ' смн/кг' : ' смн'}</span>
      </div>
      <svg ref={ref} className="tag__barcode" />
    </div>
  );
}
