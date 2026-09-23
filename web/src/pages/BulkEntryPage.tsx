import { useEffect, useRef, useState } from 'react';
import NumberInput from '../components/NumberInput';
import ScanInput from '../components/ScanInput';
import { findByScan, notFoundMessage, parseWeightLabel } from '../scan';
import { api } from '../api';
import { createProduct, receiveGoods } from '../sync';
import type { Product } from '../types';

// Конвейерный завод товаров.
//
// Риск №2 из ТЗ (п.10): первый завод ~2000 позиций — момент, где клиент бросит.
// Внешняя база названий не помогает (проверено, этап A), поэтому единственный
// способ ускорить — убрать всё лишнее из самого ввода:
//   - никаких переходов между экранами: сохранил и сразу вводишь следующий;
//   - всё с клавиатуры, Enter ведёт по полям и сохраняет;
//   - категория, единица и наценка запоминаются между товарами — коробки
//     приходят пачками однотипного товара;
//   - уже знакомый штрихкод не заводится заново, а сразу принимается на склад.

interface Added {
  name: string;
  qty: number;
  isReceipt: boolean;
}

export default function BulkEntryPage() {
  const [barcode, setBarcode] = useState('');
  const [name, setName] = useState('');
  const [cost, setCost] = useState('');
  const [sale, setSale] = useState('');
  const [qty, setQty] = useState('');

  // Запоминаем между товарами — их обычно заводят пачками.
  const [category, setCategory] = useState('');
  const [unit, setUnit] = useState<'pcs' | 'kg'>('pcs');

  // Наценку можно задать двумя способами. Не все считают в процентах:
  // «купили за 3, продаём за 5» — привычнее, чем «66.7%».
  const [markupMode, setMarkupMode] = useState<'percent' | 'example'>('percent');
  const [markup, setMarkup] = useState('30');
  const [exCost, setExCost] = useState('');
  const [exSale, setExSale] = useState('');

  // Действующая наценка в процентах — из процента либо из примера.
  const effectiveMarkup = (() => {
    if (markupMode === 'percent') return Number(markup);
    const c = Number(exCost);
    const s = Number(exSale);
    if (!(c > 0) || !(s > 0)) return NaN;
    return ((s - c) / c) * 100;
  })();

  const [existing, setExisting] = useState<Product | null>(null);
  const [added, setAdded] = useState<Added[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const barcodeRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const costRef = useRef<HTMLInputElement>(null);
  const saleRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    barcodeRef.current?.focus();
  }, []);

  // Знакомый штрихкод — значит товар уже заведён, его надо просто принять.
  useEffect(() => {
    const bc = barcode.trim();
    if (!bc) {
      setExisting(null);
      return;
    }
    let alive = true;
    findByScan(bc).then((r) => {
      if (!alive) return;
      const p = r?.kind === 'product' ? r.product : null;
      setExisting(p);
      setErr(r?.kind === 'weight_unknown' ? notFoundMessage(r) : null);
      if (p) {
        setName(p.name);
        setSale(String(p.sale_price));
        setUnit(p.unit === 'kg' ? 'kg' : 'pcs');
        // С весовой этикетки сразу знаем вес.
        if (r?.kind === 'product' && r.qty) setQty(String(r.qty));
      }
    });
    return () => {
      alive = false;
    };
  }, [barcode]);

  // Цена продажи считается от закупочной по наценке — руками её набирать
  // на каждом товаре слишком долго.
  function onCostChange(v: string) {
    setCost(v);
    const c = Number(v);
    if (c > 0 && Number.isFinite(effectiveMarkup) && !existing) {
      setSale(String(Number((c * (1 + effectiveMarkup / 100)).toFixed(2))));
    }
  }

  function resetLine(keepFocus = true) {
    setBarcode('');
    setName('');
    setCost('');
    setSale('');
    setQty('');
    setExisting(null);
    setErr(null);
    if (keepFocus) setTimeout(() => barcodeRef.current?.focus(), 0);
  }

  async function save() {
    const bc = barcode.trim();
    const qtyNum = Number(qty) || 0;

    // Весовая этикетка — не штрихкод товара: в ней вес, он каждый раз новый.
    if (!existing && parseWeightLabel(bc)) {
      setErr('Это весовая этикетка. Заведите товар без штрихкода и впишите в карточку код весов (PLU).');
      return;
    }

    if (!existing && !name.trim()) {
      setErr('Введите название');
      nameRef.current?.focus();
      return;
    }

    setBusy(true);
    setErr(null);
    try {
      if (existing) {
        // Товар уже есть — не заводим заново, а приходуем.
        if (qtyNum <= 0) {
          setErr('Введите количество для прихода');
          qtyRef.current?.focus();
          return;
        }
        await receiveGoods({
          product_id: existing.id,
          qty: qtyNum,
          cost_price: Number(cost) || undefined,
        });
        setAdded((a) => [{ name: existing.name, qty: qtyNum, isReceipt: true }, ...a].slice(0, 8));
      } else {
        const res = await createProduct({
          barcode: bc || undefined,
          name: name.trim(),
          category: category.trim(),
          unit,
          sale_price: Number(sale) || 0,
          cost_price: Number(cost) || 0,
        });
        if (res.product && qtyNum > 0) {
          await receiveGoods({ product_id: res.product.id, qty: qtyNum, cost_price: Number(cost) || undefined });
        }
        setAdded((a) => [{ name: name.trim(), qty: qtyNum, isReceipt: false }, ...a].slice(0, 8));
      }
      resetLine();
    } catch (e: any) {
      setErr(e.message || 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  }

  // Enter ведёт по полям, а в последнем — сохраняет. Руки не уходят с клавиатуры.
  function onKey(e: React.KeyboardEvent, next?: React.RefObject<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (next?.current) next.current.focus();
      else save();
    }
    if (e.key === 'Escape') resetLine();
  }

  return (
    <div className="page">
      <div className="sale-head">
        <h1>Быстрый завод</h1>
        <span className="badge badge--ok">заведено: {added.length}</span>
      </div>

      <p className="hint">
        Enter — следующее поле, в последнем — сохранить и сразу вводить следующий товар.
        Esc — очистить строку.
      </p>

      {/* Общие настройки пачки: их не надо трогать на каждом товаре. */}
      <div className="card batch-settings">
        <label className="field">
          <span>Категория пачки</span>
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="напр. Напитки" />
        </label>

        <div className="field">
          <span>Наценка — цена продажи посчитается сама</span>
          <div className="seg">
            <button
              className={`seg__btn ${markupMode === 'percent' ? 'seg__btn--on' : ''}`}
              onClick={() => setMarkupMode('percent')}
            >
              Процентом
            </button>
            <button
              className={`seg__btn ${markupMode === 'example' ? 'seg__btn--on' : ''}`}
              onClick={() => setMarkupMode('example')}
            >
              По примеру
            </button>
          </div>
        </div>

        {markupMode === 'percent' ? (
          <label className="field">
            <span>Процент</span>
            <NumberInput value={markup} onValue={setMarkup} />
          </label>
        ) : (
          <>
            <div className="row">
              <label className="field">
                <span>Купили за</span>
                <NumberInput value={exCost} onValue={setExCost} placeholder="3" />
              </label>
              <label className="field">
                <span>Продаём за</span>
                <NumberInput value={exSale} onValue={setExSale} placeholder="5" />
              </label>
            </div>
            <p className="hint">
              {Number.isFinite(effectiveMarkup)
                ? `Это наценка ${effectiveMarkup.toFixed(1)}% — она применится к остальным товарам пачки.`
                : 'Введите обе цены одного товара — по ним посчитается наценка для всей пачки.'}
            </p>
          </>
        )}
        <div className="field">
          <span>Как продаётся</span>
          <div className="seg">
            <button className={`seg__btn ${unit === 'pcs' ? 'seg__btn--on' : ''}`} onClick={() => setUnit('pcs')}>
              Поштучно
            </button>
            <button className={`seg__btn ${unit === 'kg' ? 'seg__btn--on' : ''}`} onClick={() => setUnit('kg')}>
              На вес (кг)
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        {existing && (
          <div className="warn">
            «{existing.name}» уже заведён — введите количество, товар просто придёт на склад.
            Остаток сейчас: {existing.stock} {existing.unit === 'kg' ? 'кг' : 'шт'}
          </div>
        )}

        <label className="field">
          <span>Штрихкод — можно пропустить</span>
          <ScanInput
            ref={barcodeRef}
            value={barcode}
            onValue={setBarcode}
            onCamera={(code) => {
              setBarcode(code);
              nameRef.current?.focus();
            }}
            onKeyDown={(e) => onKey(e, nameRef)}
            placeholder="скан или Enter, если штрихкода нет"
          />
        </label>

        <label className="field">
          <span>Название</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => onKey(e, costRef)}
            disabled={!!existing}
          />
        </label>

        <div className="row">
          <label className="field">
            <span>Закупочная{unit === 'kg' ? ' за кг' : ''}</span>
            <NumberInput
              ref={costRef}
              value={cost}
              onValue={onCostChange}
              onKeyDown={(e) => onKey(e, saleRef)}
            />
          </label>
          <label className="field">
            <span>Продажа{unit === 'kg' ? ' за кг' : ''}</span>
            <NumberInput
              ref={saleRef}
              value={sale}
              onValue={setSale}
              onKeyDown={(e) => onKey(e, qtyRef)}
              disabled={!!existing}
            />
          </label>
        </div>

        <label className="field">
          <span>Сколько принято{unit === 'kg' ? ', кг' : ', шт'} — можно пропустить</span>
          <NumberInput
            ref={qtyRef}
            value={qty}
            onValue={setQty}
            onKeyDown={(e) => onKey(e)}
            placeholder="Enter — сохранить"
          />
        </label>

        {err && <div className="change change--neg">{err}</div>}

        <div className="row">
          <button className="btn" onClick={() => resetLine()} disabled={busy}>
            Очистить
          </button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>
            {existing ? 'Принять' : 'Завести'} и дальше
          </button>
        </div>
      </div>

      {added.length > 0 && (
        <>
          <h2 className="sect">Последние</h2>
          <div className="list">
            {added.map((a, i) => (
              <div key={i} className="list-item list-item--static">
                <div className="list-item__main">
                  <div className="list-item__name">{a.name}</div>
                  <div className="muted">{a.isReceipt ? 'принято на склад' : 'заведён новый товар'}</div>
                </div>
                {a.qty > 0 && <div className="stock">+{a.qty}</div>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
