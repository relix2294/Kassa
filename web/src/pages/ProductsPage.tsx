import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import NumberInput from '../components/NumberInput';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { api } from '../api';
import { createProduct, updateProductRemote, pullProducts } from '../sync';
import Confirm from '../components/Confirm';
import type { Product } from '../types';

// Сколько позиций рисуем сразу. ТЗ (п.10) предупреждает про первый завод
// ~2000 товаров: рисовать их все — значит подвесить экран на слабом ноуте.
const RENDER_LIMIT = 100;

export default function ProductsPage() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState(''); // отложенное значение поиска
  const [editing, setEditing] = useState<Product | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const products = useLiveQuery(() => db.products.orderBy('name').toArray(), [], [] as Product[]);

  // Поиск с задержкой: иначе фильтр по 2000 позициям пересчитывается
  // на каждое нажатие клавиши.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  const filtered = useMemo(() => {
    const s = query.trim().toLowerCase();
    if (!s) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(s) ||
        (p.barcode ?? '').includes(s) ||
        (p.category ?? '').toLowerCase().includes(s),
    );
  }, [products, query]);

  const shown = filtered.slice(0, RENDER_LIMIT);
  const hidden = filtered.length - shown.length;

  function flash(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 2500);
  }

  return (
    <div className="page">
      <div className="sale-head">
        <h1>Товары</h1>
        <div className="staff-actions">
          <Link className="btn btn--ghost" to="/bulk">Быстрый завод</Link>
          <button className="btn btn--ghost" onClick={() => setAdding(true)}>
            + Товар
          </button>
        </div>
      </div>

      <input
        className="search"
        placeholder="Поиск по названию, штрихкоду, категории"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {products.length === 0 && (
        <p className="hint">
          Пока пусто. Заведите товар кнопкой «+ Товар» или отсканируйте новый штрихкод на вкладке «Приём».
        </p>
      )}
      {products.length > 0 && filtered.length === 0 && <p className="hint">Ничего не нашлось.</p>}

      <div className="list">
        {shown.map((p) => {
          const low = p.stock <= p.min_stock && p.min_stock > 0;
          return (
            <button key={p.id} className="list-item" onClick={() => setEditing(p)}>
              <div className="list-item__main">
                <div className="list-item__name">
                  {p.name}
                  {p.discount_price != null && <span className="badge badge--sale">скидка</span>}
                </div>
                <div className="muted">
                  {p.barcode || 'без штрихкода'}
                  {p.category ? ` · ${p.category}` : ''}
                </div>
              </div>
              <div className="list-item__side">
                <div className={`stock ${low ? 'stock--low' : ''}`}>
                  {p.stock} {p.unit === 'kg' ? 'кг' : 'шт'}
                </div>
                <div className="muted">
                  {p.discount_price != null ? (
                    <><span className="price-old">{p.sale_price}</span> {p.discount_price}</>
                  ) : (
                    <>{p.sale_price}</>
                  )}{p.unit === 'kg' ? ' /кг' : ''} прод.{p.cost_price != null ? ` · ${p.cost_price} закуп.` : ''}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {hidden > 0 && (
        <p className="hint">
          Показано {shown.length} из {filtered.length}. Уточните поиск, чтобы найти нужный товар.
        </p>
      )}

      {adding && (
        <AddProduct
          onClose={() => setAdding(false)}
          onDone={(name) => {
            setAdding(false);
            flash(`Заведён: ${name}`);
          }}
        />
      )}

      {editing && (
        <EditModal
          product={editing}
          onClose={() => setEditing(null)}
          onSaved={(m) => {
            setEditing(null);
            flash(m);
          }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// Завести товар заранее, без коробки в руках: штрихкод вводится вручную.
function AddProduct({ onClose, onDone }: { onClose: () => void; onDone: (name: string) => void }) {
  const [barcode, setBarcode] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [sale, setSale] = useState('');
  const [cost, setCost] = useState('');
  const [min, setMin] = useState('0');
  const [unit, setUnit] = useState<'pcs' | 'kg'>('pcs');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) {
      setErr('Название обязательно');
      return;
    }
    // Цена продажи обязательна: без неё товар продастся за 0.
    if (!(Number(sale) > 0)) {
      setErr('Укажите цену продажи');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await createProduct({
        barcode: barcode.trim() || undefined, // у весового товара его нет
        name: name.trim(),
        category: category.trim(),
        unit,
        sale_price: Number(sale) || 0,
        cost_price: Number(cost) || 0,
        min_stock: Number(min) || 0,
      });
      onDone(name.trim());
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Новый товар</h2>
        <p className="muted">Остаток появится после приёма — здесь только карточка.</p>

        <label className="field">
          <span>Название</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>

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

        <label className="field">
          <span>Штрихкод — необязательно</span>
          <NumberInput
            mode="int"
            value={barcode}
            onValue={setBarcode}
            placeholder={unit === 'kg' ? 'у весового обычно нет' : 'если есть на упаковке'}
          />
        </label>
        <label className="field">
          <span>Категория</span>
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="напр. Напитки" />
        </label>
        <div className="row">
          <label className="field">
            <span>Цена продажи{unit === 'kg' ? ' за кг' : ''} — обязательно</span>
            <NumberInput value={sale} onValue={setSale} />
          </label>
          <label className="field">
            <span>Закупочная{unit === 'kg' ? ' за кг' : ''}</span>
            <NumberInput value={cost} onValue={setCost} />
          </label>
        </div>
        <label className="field">
          <span>Мин. остаток{unit === 'kg' ? ', кг' : ', шт'}</span>
          <NumberInput value={min} onValue={setMin} />
        </label>

        {err && <div className="change change--neg">{err}</div>}

        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>
            Завести
          </button>
        </div>
      </div>
    </div>
  );
}

function EditModal({
  product,
  onClose,
  onSaved,
}: {
  product: Product;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState(product.category ?? '');
  const [sale, setSale] = useState(String(product.sale_price));
  const [cost, setCost] = useState(String(product.cost_price ?? ''));
  const [min, setMin] = useState(String(product.min_stock));
  const [stock, setStock] = useState(String(product.stock));
  const [unit, setUnit] = useState<'pcs' | 'kg'>(product.unit === 'kg' ? 'kg' : 'pcs');
  const [busy, setBusy] = useState(false);
  const [askArchive, setAskArchive] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Скидка на товар (только владелец). Отдельная кнопка — назначить/снять.
  const [discPrice, setDiscPrice] = useState(product.discount_price != null ? String(product.discount_price) : '');
  const [discLimit, setDiscLimit] = useState(product.discount_left != null ? String(product.discount_left) : '');
  const [discErr, setDiscErr] = useState<string | null>(null);
  const hasDiscount = product.discount_price != null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{product.name}</h2>
        <div className="muted mb">
          {product.barcode || 'без штрихкода'} · остаток {product.stock} {unit === 'kg' ? 'кг' : 'шт'}
        </div>

        <label className="field">
          <span>Название</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Категория</span>
          <input value={category} onChange={(e) => setCategory(e.target.value)} />
        </label>

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
        <div className="row">
          <label className="field">
            <span>Цена продажи{unit === 'kg' ? ' за кг' : ''}</span>
            <NumberInput value={sale} onValue={setSale} />
          </label>
          <label className="field">
            <span>Закупочная{unit === 'kg' ? ' за кг' : ''}</span>
            <NumberInput value={cost} onValue={setCost} />
          </label>
        </div>
        <div className="row">
          <label className="field">
            <span>Остаток сейчас{unit === 'kg' ? ', кг' : ', шт'}</span>
            <NumberInput value={stock} onValue={setStock} mode={unit === 'kg' ? 'decimal' : 'int'} />
          </label>
          <label className="field">
            <span>Мин. остаток{unit === 'kg' ? ', кг' : ', шт'}</span>
            <NumberInput value={min} onValue={setMin} />
          </label>
        </div>
        <p className="hint">Остаток — только для исправления ошибок. Правка попадёт в журнал.</p>

        {/* Скидка. Задаёт только владелец; кассир при продаже её просто применяет. */}
        <div className="discount-box">
          <div className="discount-box__head">
            <span>Скидка{hasDiscount ? ' (действует)' : ''}</span>
            {hasDiscount && (
              <button
                className="btn btn--link"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  try {
                    await api.setDiscount(product.id, { clear: true });
                    await pullProducts();
                    onSaved('Скидка снята');
                  } catch (e: any) {
                    setErr(e.message || 'Не удалось снять скидку');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Снять
              </button>
            )}
          </div>
          <div className="row">
            <label className="field">
              <span>Акционная цена{unit === 'kg' ? ' за кг' : ''}</span>
              <NumberInput value={discPrice} onValue={setDiscPrice} placeholder={`меньше ${sale}`} />
            </label>
            <label className="field">
              <span>Лимит {unit === 'kg' ? 'кг' : 'шт'} — пусто без лимита</span>
              <NumberInput value={discLimit} onValue={setDiscLimit} placeholder="напр. 20" />
            </label>
          </div>
          {discErr && <div className="change change--neg">{discErr}</div>}
          <button
            className="btn"
            disabled={busy || !discPrice}
            onClick={async () => {
              setBusy(true);
              setDiscErr(null);
              try {
                await api.setDiscount(product.id, {
                  discount_price: Number(discPrice),
                  discount_limit: discLimit === '' ? null : Number(discLimit),
                });
                await pullProducts();
                onSaved('Скидка назначена');
              } catch (e: any) {
                setDiscErr(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {hasDiscount ? 'Обновить скидку' : 'Назначить скидку'}
          </button>
        </div>

        {err && <div className="change change--neg">{err}</div>}

        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button
            className="btn btn--primary"
            disabled={busy}
            onClick={async () => {
              if (!name.trim()) { setErr('Название обязательно'); return; }
              if (!(Number(sale) > 0)) { setErr('Цена продажи должна быть больше 0'); return; }
              setBusy(true);
              setErr(null);
              try {
                await updateProductRemote(product.id, {
                  name: name.trim(),
                  category: category.trim(),
                  unit,
                  sale_price: Number(sale),
                  cost_price: Number(cost),
                  min_stock: Number(min),
                  stock: Number(stock),
                });
                onSaved('Сохранено');
              } catch (e: any) {
                setErr(e.message || 'Не удалось сохранить');
              } finally {
                setBusy(false);
              }
            }}
          >
            Сохранить
          </button>
        </div>

        <button className="btn btn--link" onClick={() => setAskArchive(true)} disabled={busy}>
          Убрать товар из работы
        </button>

        {askArchive && (
          <Confirm
            title="Убрать товар?"
            text={`«${product.name}» пропадёт из кассы и списков. История продаж останется, вернуть можно в любой момент.`}
            confirmLabel="Убрать"
            danger
            onConfirm={async () => {
              setAskArchive(false);
              setBusy(true);
              setErr(null);
              try {
                await api.archiveProduct(product.id, true);
                await db.products.delete(product.id);
                await pullProducts();
                onSaved('Товар убран из работы');
              } catch (e: any) {
                setErr(e.message || 'Не удалось убрать товар');
              } finally {
                setBusy(false);
              }
            }}
            onCancel={() => setAskArchive(false)}
          />
        )}
      </div>
    </div>
  );
}
