import { useCallback, useEffect, useState } from 'react';
import NumberInput from '../components/NumberInput';
import { api } from '../api';

// Поставщики и долги (постоплата): кому и сколько должны, история платежей.
export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [totalDebt, setTotalDebt] = useState(0);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listSuppliers().then((r) => { setSuppliers(r.suppliers); setTotalDebt(r.total_debt); }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2500); }

  return (
    <div className="page">
      <div className="sale-head">
        <h1>Долги</h1>
        <button className="btn btn--ghost" onClick={() => setAdding(true)}>+ Поставщик</button>
      </div>

      <div className={`kpi ${totalDebt > 0 ? 'kpi--danger' : ''}`}>
        <div className="kpi__label">Всего должны поставщикам</div>
        <div className="kpi__value">{totalDebt.toFixed(2)}</div>
      </div>

      {suppliers.length === 0 && <p className="hint">Пока нет поставщиков. Заведите первого кнопкой «+ Поставщик».</p>}

      <div className="list">
        {suppliers.map((s) => (
          <button key={s.id} className="list-item" onClick={() => setOpenId(s.id)}>
            <div className="list-item__main">
              <div className="list-item__name">{s.name}</div>
              <div className="muted">{s.phone || 'без телефона'} · накладных: {s.invoices}</div>
            </div>
            <div className={`stock ${Number(s.debt) > 0 ? 'stock--low' : ''}`}>
              {Number(s.debt) > 0 ? `долг ${Number(s.debt).toFixed(2)}` : 'нет долга'}
            </div>
          </button>
        ))}
      </div>

      {adding && (
        <AddSupplier
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); load(); flash('Поставщик добавлен'); }}
        />
      )}

      {openId && (
        <SupplierDetail
          id={openId}
          onClose={() => { setOpenId(null); load(); }}
          onChange={load}
          onFlash={flash}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function AddSupplier({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) { setErr('Укажите имя'); return; }
    setBusy(true); setErr(null);
    try {
      await api.createSupplier({ name: name.trim(), phone: phone.trim() || undefined });
      onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Новый поставщик</h2>
        <label className="field"><span>Название / имя</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Оптбаза Сомони" autoFocus />
        </label>
        <label className="field"><span>Телефон</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="необязательно" />
        </label>
        {err && <div className="change change--neg">{err}</div>}
        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>Добавить</button>
        </div>
      </div>
    </div>
  );
}

function SupplierDetail({ id, onClose, onChange, onFlash }: {
  id: string; onClose: () => void; onChange: () => void; onFlash: (m: string) => void;
}) {
  const [data, setData] = useState<any | null>(null);
  const [addInv, setAddInv] = useState(false);
  const [payFor, setPayFor] = useState<any | null>(null);

  const reload = useCallback(() => {
    api.getSupplier(id).then(setData).catch(() => {});
  }, [id]);
  useEffect(() => { reload(); }, [reload]);

  if (!data) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{data.supplier.name}</h2>
        <div className="muted mb">
          {data.supplier.phone || 'без телефона'} · долг:{' '}
          <b className={data.debt > 0 ? 'diff-neg' : ''}>{Number(data.debt).toFixed(2)}</b>
        </div>

        <button className="btn btn--primary btn--pick" onClick={() => setAddInv(true)}>+ Накладная</button>

        {data.invoices.length === 0 && <p className="hint">Накладных пока нет.</p>}

        <div className="list">
          {data.invoices.map((i: any) => (
            <div key={i.id} className="list-item list-item--static">
              <div className="list-item__main">
                <div className="list-item__name">
                  {new Date(i.created_at).toLocaleDateString('ru-RU')} · накладная {Number(i.total).toFixed(2)}
                </div>
                <div className="muted">
                  оплачено {Number(i.paid).toFixed(2)}
                  {i.note ? ` · ${i.note}` : ''}
                </div>
              </div>
              <div className="list-item__side">
                <div className={`stock ${Number(i.remaining) > 0 ? 'stock--low' : ''}`}>
                  {Number(i.remaining) > 0 ? `−${Number(i.remaining).toFixed(2)}` : 'оплачено'}
                </div>
                {Number(i.remaining) > 0 && (
                  <button className="btn btn--link" onClick={() => setPayFor(i)}>Оплатить</button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="row">
          <button className="btn" onClick={onClose}>Закрыть</button>
        </div>
      </div>

      {addInv && (
        <AddInvoice
          supplierId={id}
          onClose={() => setAddInv(false)}
          onDone={() => { setAddInv(false); reload(); onChange(); onFlash('Накладная добавлена'); }}
        />
      )}
      {payFor && (
        <PayInvoice
          invoice={payFor}
          onClose={() => setPayFor(null)}
          onDone={() => { setPayFor(null); reload(); onChange(); onFlash('Платёж внесён'); }}
        />
      )}
    </div>
  );
}

function AddInvoice({ supplierId, onClose, onDone }: { supplierId: string; onClose: () => void; onDone: () => void }) {
  const [total, setTotal] = useState('');
  const [paid, setPaid] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const debt = (Number(total) || 0) - (Number(paid) || 0);

  async function save() {
    const t = Number(total) || 0;
    const p = Number(paid) || 0;
    if (!(t > 0)) { setErr('Укажите сумму накладной'); return; }
    if (p > t) { setErr('Оплачено больше суммы накладной'); return; }
    setBusy(true); setErr(null);
    try {
      await api.addInvoice(supplierId, { total: t, paid: p, note: note.trim() || undefined });
      onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Новая накладная</h2>
        <div className="row">
          <label className="field"><span>Сумма накладной</span><NumberInput value={total} onValue={setTotal} autoFocus /></label>
          <label className="field"><span>Оплатили сейчас</span><NumberInput value={paid} onValue={setPaid} placeholder="0" /></label>
        </div>
        <label className="field"><span>Заметка</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="напр. Кола, вода — партия" />
        </label>
        {Number(total) > 0 && (
          <div className={`shift-diff ${debt > 0 ? 'shift-diff--neg' : ''}`}>
            Долг по накладной: <b>{debt.toFixed(2)}</b>
          </div>
        )}
        {err && <div className="change change--neg">{err}</div>}
        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}

function PayInvoice({ invoice, onClose, onDone }: { invoice: any; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remaining = Number(invoice.remaining);

  async function save() {
    const a = Number(amount) || 0;
    if (!(a > 0)) { setErr('Укажите сумму'); return; }
    if (a > remaining) { setErr(`Осталось всего ${remaining.toFixed(2)}`); return; }
    setBusy(true); setErr(null);
    try {
      await api.payInvoice(invoice.id, { amount: a, note: note.trim() || undefined });
      onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Оплата поставщику</h2>
        <p className="muted">По накладной осталось: <b>{remaining.toFixed(2)}</b></p>
        <div className="row">
          <button className="btn btn--ghost" onClick={() => setAmount(String(remaining))}>Погасить всё</button>
        </div>
        <label className="field"><span>Сколько платим</span><NumberInput value={amount} onValue={setAmount} autoFocus /></label>
        <label className="field"><span>Заметка</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="необязательно" />
        </label>
        {err && <div className="change change--neg">{err}</div>}
        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>Внести платёж</button>
        </div>
      </div>
    </div>
  );
}
