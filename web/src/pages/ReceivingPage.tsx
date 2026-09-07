import { useEffect, useRef, useState } from 'react';
import { db } from '../db';
import { api } from '../api';
import { createProduct, receiveGoods } from '../sync';
import { useCurrentUser } from '../session';
import type { Product } from '../types';

type Stage = 'scan' | 'receive' | 'create';

export default function ReceivingPage() {
  const user = useCurrentUser();
  const [stage, setStage] = useState<Stage>('scan');
  const [barcode, setBarcode] = useState('');
  const [product, setProduct] = useState<Product | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scanRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (stage === 'scan') scanRef.current?.focus();
  }, [stage]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  // Скан штрихкода: ищем товар локально, иначе — заведение нового.
  async function onScan(code: string) {
    const bc = code.trim();
    if (!bc) return;
    setBarcode(bc);
    const local = await db.products.where('barcode').equals(bc).first();
    if (local) {
      setProduct(local);
      setStage('receive');
    } else {
      setProduct(null);
      setStage('create');
    }
  }

  function reset() {
    setStage('scan');
    setBarcode('');
    setProduct(null);
  }

  return (
    <div className="page">
      <h1>Приём товара</h1>

      {stage === 'scan' && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            onScan(barcode);
          }}
        >
          <label className="field">
            <span>Отсканируйте или введите штрихкод</span>
            <input
              ref={scanRef}
              inputMode="numeric"
              autoFocus
              placeholder="Штрихкод…"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
            />
          </label>
          <button className="btn btn--primary" type="submit">
            Дальше
          </button>
          <p className="hint">Сканер сам вводит код и жмёт Enter.</p>
        </form>
      )}

      {stage === 'receive' && product && (
        <ReceiveExisting
          product={product}
          busy={busy}
          onCancel={reset}
          onSubmit={async (qty, cost) => {
            setBusy(true);
            try {
              const r = await receiveGoods({
                barcode: product.barcode,
                qty,
                cost_price: cost,
                user_id: user?.id,
              });
              flash(r.queued ? 'Нет сети — приём в очереди' : `Принято: ${product.name} +${qty}`);
              reset();
            } catch (e: any) {
              flash(`Ошибка: ${e.message}`);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {stage === 'create' && (
        <CreateProduct
          barcode={barcode}
          busy={busy}
          onCancel={reset}
          onSubmit={async (fields, qty, cost) => {
            setBusy(true);
            try {
              const res = await createProduct({ ...fields, barcode, user_id: user?.id });
              if (res.queued || !res.product) {
                flash('Нет сети — товар в очереди на создание');
                reset();
                return;
              }
              // Сразу приходуем стартовое количество, если задано.
              if (qty > 0) {
                await receiveGoods({ barcode, qty, cost_price: cost, user_id: user?.id });
              }
              flash(`Заведён: ${fields.name}${qty > 0 ? ` (+${qty})` : ''}`);
              reset();
            } catch (e: any) {
              flash(`Ошибка: ${e.message}`);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function ReceiveExisting({
  product,
  busy,
  onSubmit,
  onCancel,
}: {
  product: Product;
  busy: boolean;
  onSubmit: (qty: number, cost: number) => void;
  onCancel: () => void;
}) {
  const [qty, setQty] = useState('1');
  const [cost, setCost] = useState(String(product.cost_price || ''));

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(Number(qty), Number(cost));
      }}
    >
      <div className="product-head">
        <div className="product-name">{product.name}</div>
        <div className="muted">{product.barcode}</div>
        <div className="muted">
          Остаток сейчас: <b>{product.stock}</b> · цена продажи {product.sale_price}
        </div>
      </div>

      <label className="field">
        <span>Сколько принято</span>
        <input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span>Закупочная цена за единицу</span>
        <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
      </label>

      <div className="row">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Отмена
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy || !(Number(qty) > 0)}>
          Принять
        </button>
      </div>
    </form>
  );
}

function CreateProduct({
  barcode,
  busy,
  onSubmit,
  onCancel,
}: {
  barcode: string;
  busy: boolean;
  onSubmit: (
    fields: { name: string; category: string; sale_price: number; cost_price: number; min_stock: number },
    qty: number,
    cost: number,
  ) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [minStock, setMinStock] = useState('0');
  const [qty, setQty] = useState('0');
  const [looking, setLooking] = useState(true);

  // Пытаемся подтянуть название из внешней базы (п.5 ТЗ).
  useEffect(() => {
    let alive = true;
    api
      .lookupBarcode(barcode)
      .then((r) => {
        if (alive && r.name) setName(r.name);
      })
      .finally(() => alive && setLooking(false));
    return () => {
      alive = false;
    };
  }, [barcode]);

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(
          {
            name: name.trim(),
            category: category.trim(),
            sale_price: Number(salePrice),
            cost_price: Number(costPrice),
            min_stock: Number(minStock),
          },
          Number(qty),
          Number(costPrice),
        );
      }}
    >
      <div className="product-head">
        <div className="badge badge--new">Новый товар</div>
        <div className="muted">{barcode}</div>
      </div>

      <label className="field">
        <span>Название {looking && <em className="muted">(ищем в базе…)</em>}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название товара" autoFocus />
      </label>
      <label className="field">
        <span>Категория</span>
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="напр. Напитки" />
      </label>
      <div className="row">
        <label className="field">
          <span>Цена продажи</span>
          <input inputMode="decimal" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} />
        </label>
        <label className="field">
          <span>Закупочная</span>
          <input inputMode="decimal" value={costPrice} onChange={(e) => setCostPrice(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <label className="field">
          <span>Мин. остаток</span>
          <input inputMode="decimal" value={minStock} onChange={(e) => setMinStock(e.target.value)} />
        </label>
        <label className="field">
          <span>Принять сразу (шт)</span>
          <input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
      </div>

      <div className="row">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Отмена
        </button>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || !name.trim() || !(Number(salePrice) >= 0)}
        >
          Завести товар
        </button>
      </div>
    </form>
  );
}
