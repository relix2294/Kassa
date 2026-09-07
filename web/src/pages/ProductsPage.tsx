import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { updateProductRemote } from '../sync';
import { useCurrentUser } from '../session';
import type { Product } from '../types';

export default function ProductsPage() {
  const user = useCurrentUser();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Product | null>(null);

  const products = useLiveQuery(() => db.products.orderBy('name').toArray(), [], [] as Product[]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return products;
    return products.filter(
      (p) => p.name.toLowerCase().includes(s) || p.barcode.includes(s) || (p.category ?? '').toLowerCase().includes(s),
    );
  }, [products, q]);

  return (
    <div className="page">
      <h1>Товары</h1>

      <input
        className="search"
        placeholder="Поиск по названию, штрихкоду, категории"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {filtered.length === 0 && <p className="hint">Пока пусто. Заведите товары на вкладке «Приём».</p>}

      <div className="list">
        {filtered.map((p) => {
          const low = p.stock <= p.min_stock && p.min_stock > 0;
          return (
            <button key={p.id} className="list-item" onClick={() => setEditing(p)}>
              <div className="list-item__main">
                <div className="list-item__name">{p.name}</div>
                <div className="muted">
                  {p.barcode}
                  {p.category ? ` · ${p.category}` : ''}
                </div>
              </div>
              <div className="list-item__side">
                <div className={`stock ${low ? 'stock--low' : ''}`}>{p.stock} шт</div>
                <div className="muted">{p.sale_price} прод. · {p.cost_price} закуп.</div>
              </div>
            </button>
          );
        })}
      </div>

      {editing && (
        <EditModal
          product={editing}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            await updateProductRemote(editing.id, { ...patch, user_id: user?.id });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function EditModal({
  product,
  onClose,
  onSave,
}: {
  product: Product;
  onClose: () => void;
  onSave: (patch: { sale_price?: number; cost_price?: number; min_stock?: number; name?: string; category?: string }) => void;
}) {
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState(product.category ?? '');
  const [sale, setSale] = useState(String(product.sale_price));
  const [cost, setCost] = useState(String(product.cost_price));
  const [min, setMin] = useState(String(product.min_stock));
  const [busy, setBusy] = useState(false);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{product.name}</h2>
        <div className="muted mb">{product.barcode} · остаток {product.stock}</div>

        <label className="field">
          <span>Название</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Категория</span>
          <input value={category} onChange={(e) => setCategory(e.target.value)} />
        </label>
        <div className="row">
          <label className="field">
            <span>Цена продажи</span>
            <input inputMode="decimal" value={sale} onChange={(e) => setSale(e.target.value)} />
          </label>
          <label className="field">
            <span>Закупочная</span>
            <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Мин. остаток</span>
          <input inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />
        </label>

        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button
            className="btn btn--primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave({
                  name: name.trim(),
                  category: category.trim(),
                  sale_price: Number(sale),
                  cost_price: Number(cost),
                  min_stock: Number(min),
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}
