import { useState } from 'react';
import NumberInput from './NumberInput';
import { db } from '../db';
import { api } from '../api';
import { updateProductRemote, pullProducts } from '../sync';
import Confirm from './Confirm';
import type { Product } from '../types';

// Редактирование карточки товара: название, категория, цены, остаток, скидка,
// архивирование. Общий компонент для экрана «Товары» и вкладки «Остатки» в
// Кабинете — чтобы правка была в одном месте и вела себя одинаково.
export default function ProductEditModal({
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
      <div className="modal modal--scroll" onClick={(e) => e.stopPropagation()}>
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
