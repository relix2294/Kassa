import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import Keypad from './Keypad';
import type { Product } from '../types';

// Выбор товара без сканера.
// Нужен для весового товара и выпечки: у них штрихкода обычно нет вообще,
// а продавать их надо так же быстро, как сканируемые.
export default function ProductPicker({
  onPick,
  onClose,
}: {
  onPick: (product: Product, qty: number) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Product | null>(null);
  const [amount, setAmount] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const products = useLiveQuery(() => db.products.orderBy('name').toArray(), [], [] as Product[]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Сначала показываем товары без штрихкода — их иначе никак не продать.
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const matched = s
      ? products.filter((p) => p.name.toLowerCase().includes(s) || (p.category ?? '').toLowerCase().includes(s))
      : products;
    return [...matched]
      .sort((a, b) => Number(!!a.barcode) - Number(!!b.barcode))
      .slice(0, 40);
  }, [products, q]);

  // Выбран весовой товар — спрашиваем вес.
  if (picked && picked.unit === 'kg') {
    const kg = Number(amount) || 0;
    const sum = Number((kg * Number(picked.sale_price)).toFixed(2));
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2>{picked.name}</h2>
          <div className="muted">{picked.sale_price} за кг · на складе {picked.stock} кг</div>

          <div className="field">
            <span>Вес, кг</span>
            <div className="keypad-value">{amount || '0'}</div>
          </div>
          <Keypad value={amount} onChange={setAmount} allowDecimal />

          <div className="change-box change-box--ok">
            <div className="change-box__label">Сумма</div>
            <div className="change-box__sum">{sum.toFixed(2)}</div>
          </div>

          <div className="row">
            <button className="btn" onClick={() => { setPicked(null); setAmount(''); }}>
              Назад
            </button>
            <button className="btn btn--primary" disabled={!(kg > 0)} onClick={() => onPick(picked, kg)}>
              В чек
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Найти товар</h2>
        <input
          ref={searchRef}
          className="search"
          placeholder="Название или категория…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        {list.length === 0 && <p className="hint">Ничего не нашлось.</p>}

        <div className="cart">
          {list.map((p) => (
            <button
              key={p.id}
              className="list-item"
              onClick={() => {
                // Штучный добавляем сразу, весовой — через ввод веса.
                if (p.unit === 'kg') setPicked(p);
                else onPick(p, 1);
              }}
            >
              <div className="list-item__main">
                <div className="list-item__name">{p.name}</div>
                <div className="muted">
                  {p.category || '—'}
                  {p.barcode ? ` · ${p.barcode}` : ' · без штрихкода'}
                </div>
              </div>
              <div className="list-item__side">
                <div className="stock">{p.sale_price}{p.unit === 'kg' ? ' /кг' : ''}</div>
                <div className="muted">{p.stock} {p.unit === 'kg' ? 'кг' : 'шт'}</div>
              </div>
            </button>
          ))}
        </div>

        <button className="btn" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}
