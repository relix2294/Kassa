import { useEffect, useRef, useState } from 'react';
import NumberInput from '../components/NumberInput';
import ScanInput from '../components/ScanInput';
import { findByScan, notFoundMessage, useScanCapture } from '../scan';
import { beepError, beepOk } from '../beep';
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
  // Вес с весовой этикетки — подставляем как принятое количество.
  const [scannedQty, setScannedQty] = useState<number | undefined>();
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
    const r = await findByScan(code);
    if (!r) return;
    setBarcode(r.code);
    if (r.kind === 'product') {
      beepOk();
      setProduct(r.product);
      setScannedQty(r.qty);
      setStage('receive');
    } else if (r.kind === 'weight_unknown') {
      // Весовую этикетку нельзя заводить как штрихкод: в ней вес, он каждый раз новый.
      beepError();
      setBarcode('');
      flash(notFoundMessage(r));
    } else if (user?.role === 'cashier') {
      // Кассир не заводит товар и не задаёт цены — это делает владелец.
      beepError();
      setBarcode('');
      flash('Товара нет. Завести новый может только владелец.');
    } else {
      beepOk();
      setProduct(null);
      setStage('create');
    }
  }

  useScanCapture(onScan, stage === 'scan');

  function reset() {
    setStage('scan');
    setBarcode('');
    setProduct(null);
    setScannedQty(undefined);
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
            <ScanInput
              ref={scanRef}
              autoFocus
              placeholder="Штрихкод…"
              value={barcode}
              onValue={setBarcode}
              onCamera={onScan}
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
          initialQty={scannedQty}
          isOwner={user?.role === 'owner'}
          busy={busy}
          onCancel={reset}
          onSubmit={async (qty, cost) => {
            setBusy(true);
            try {
              const r = await receiveGoods({
                product_id: product.id,
                qty,
                // Закупочную цену задаёт только владелец.
                cost_price: user?.role === 'owner' ? cost : undefined,
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
                await receiveGoods({ barcode, qty, cost_price: cost });
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
  initialQty,
  isOwner,
  busy,
  onSubmit,
  onCancel,
}: {
  product: Product;
  initialQty?: number;
  isOwner: boolean;
  busy: boolean;
  onSubmit: (qty: number, cost: number) => void;
  onCancel: () => void;
}) {
  const [qty, setQty] = useState(String(initialQty ?? 1));
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
          Остаток сейчас: <b>{product.stock} {product.unit === 'kg' ? 'кг' : 'шт'}</b>
          {' · '}цена продажи {product.sale_price}{product.unit === 'kg' ? ' /кг' : ''}
        </div>
      </div>

      <label className="field">
        <span>Сколько принято{product.unit === 'kg' ? ', кг' : ', шт'}</span>
        <NumberInput value={qty} onValue={setQty} autoFocus />
      </label>

      {/* Закупочную цену видит и задаёт только владелец (п.4 ТЗ). */}
      {isOwner ? (
        <label className="field">
          <span>Закупочная цена за единицу</span>
          <NumberInput value={cost} onValue={setCost} />
        </label>
      ) : (
        <p className="hint">Закупочную цену задаёт владелец.</p>
      )}

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
  // Название подставлено из внешней базы — его обязательно надо проверить
  // глазами: база может вернуть чужой товар (проверено на выдуманном коде).
  const [suggested, setSuggested] = useState(false);

  // Пытаемся подтянуть название из внешней базы (п.5 ТЗ).
  useEffect(() => {
    let alive = true;
    api
      .lookupBarcode(barcode)
      .then((r) => {
        if (alive && r.name) {
          setName(r.name);
          setSuggested(true);
        }
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
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSuggested(false);
          }}
          placeholder="Название товара"
          autoFocus
        />
        {suggested && (
          <span className="warn warn--inline">
            Подставлено из внешней базы — сверьте с упаковкой, она часто ошибается.
          </span>
        )}
      </label>
      <label className="field">
        <span>Категория</span>
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="напр. Напитки" />
      </label>
      <div className="row">
        <label className="field">
          <span>Цена продажи</span>
          <NumberInput value={salePrice} onValue={setSalePrice} />
        </label>
        <label className="field">
          <span>Закупочная</span>
          <NumberInput value={costPrice} onValue={setCostPrice} />
        </label>
      </div>
      <div className="row">
        <label className="field">
          <span>Мин. остаток</span>
          <NumberInput value={minStock} onValue={setMinStock} />
        </label>
        <label className="field">
          <span>Принять сразу (шт)</span>
          <NumberInput value={qty} onValue={setQty} />
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
