import { useCallback, useEffect, useState } from 'react';
import NumberInput from '../components/NumberInput';
import { api, type Range } from '../api';
import { onRealtimeEvent } from '../sync';
import RangeControl, { money } from '../components/RangeControl';
import { SourcePicker, useMoneyPlaces, tillSub, type MoneyPlaces, type SourceOption } from '../components/MoneySource';

const SOURCE_LABEL: Record<string, string> = {
  cash: 'из кассы (нал)', wallet: 'из кассы (безнал)', hand: 'с рук (подотчёт)', external: 'со стороны',
};

// Поставщики и долги (постоплата): кому и сколько должны, история платежей.
export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [totalDebt, setTotalDebt] = useState(0);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [range, setRange] = useState<Range>({ period: '30d' });
  const [stats, setStats] = useState<{
    paid: number; paid_cash: number; paid_wallet: number; paid_hand: number; paid_external: number;
    payments: number; purchased: number; invoices: number;
    by_supplier: { id: string; name: string; paid: number; payments: number; paid_hand: number; paid_external: number }[];
    payments_list: Awaited<ReturnType<typeof api.supplierStats>>['payments_list'];
  } | null>(null);

  const load = useCallback(() => {
    api.listSuppliers().then((r) => { setSuppliers(r.suppliers); setTotalDebt(r.total_debt); }).catch(() => {});
  }, []);
  const loadStats = useCallback(() => {
    api.supplierStats(range).then(setStats).catch(() => {});
  }, [range]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => onRealtimeEvent((t) => {
    if (t === 'shift' || t === 'data_updated') { load(); loadStats(); }
  }), [load, loadStats]);

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2500); }

  const paidFromTill = stats ? stats.paid_cash + stats.paid_wallet : 0;

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

      <h2 className="sect">Движение за период</h2>
      <RangeControl range={range} onChange={setRange} />
      <div className="kpi-grid">
        <Kpi label="Оплачено поставщикам" value={money(stats?.paid ?? 0)} big />
        <Kpi label="Из кассы" value={money(paidFromTill)} hint={stats && paidFromTill > 0 ? `нал ${money(stats.paid_cash)} · безнал ${money(stats.paid_wallet)}` : undefined} />
        <Kpi label="С рук (подотчёт)" value={money(stats?.paid_hand ?? 0)} />
        <Kpi label="Со стороны" value={money(stats?.paid_external ?? 0)} />
        <Kpi label="Закуплено (накладные)" value={money(stats?.purchased ?? 0)} hint={stats ? `платежей: ${stats.payments} · накладных: ${stats.invoices}` : undefined} />
      </div>

      {/* Кому и сколько заплатили за выбранный период — сводка по поставщикам. */}
      {stats && stats.by_supplier.length > 0 && (
        <>
          <h2 className="sect">Кому заплатили · {stats.by_supplier.length}</h2>
          <div className="list">
            {stats.by_supplier.map((r) => {
              const extra = [
                r.paid_hand > 0 ? `с рук ${money(r.paid_hand)}` : '',
                r.paid_external > 0 ? `со стороны ${money(r.paid_external)}` : '',
              ].filter(Boolean).join(' · ');
              return (
                <button key={r.id} className="list-item" onClick={() => setOpenId(r.id)}>
                  <div className="list-item__main">
                    <div className="list-item__name">{r.name}</div>
                    <div className="muted">платежей: {r.payments}{extra ? ` · из них ${extra}` : ''}</div>
                  </div>
                  <div className="stock">{money(r.paid)}</div>
                </button>
              );
            })}
          </div>

          {/* Журнал: каждый платёж отдельной строкой — когда, кому, откуда деньги, кто внёс. */}
          <h2 className="sect">Журнал платежей · {stats.payments_list.length}</h2>
          <div className="list">
            {stats.payments_list.map((p) => (
              <button key={p.id} className="list-item" onClick={() => setOpenId(p.supplier_id)}>
                <div className="list-item__main">
                  <div className="list-item__name">{p.supplier_name}</div>
                  <div className="muted">
                    {new Date(p.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    {' · '}{SOURCE_LABEL[p.source] ?? p.source}
                    {p.by_user ? ` · внёс ${p.by_user}` : ''}
                  </div>
                  <div className="muted">
                    накладная от {new Date(p.invoice_at).toLocaleDateString('ru-RU')} на {money(p.invoice_total)}
                    {p.note ? ` · ${p.note}` : ''}
                  </div>
                </div>
                <div className="stock">{money(p.amount)}</div>
              </button>
            ))}
          </div>
        </>
      )}
      {stats && stats.by_supplier.length === 0 && <p className="hint">За этот период платежей поставщикам не было.</p>}

      <h2 className="sect">Поставщики и долги</h2>
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

function Kpi({ label, value, big, hint }: { label: string; value: string; big?: boolean; hint?: string }) {
  return (
    <div className={`kpi ${big ? 'kpi--big' : ''}`}>
      <div className="kpi__label">{label}</div>
      <div className="kpi__value">{value}</div>
      {hint && <div className="kpi__hint">{hint}</div>}
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
  const [editSup, setEditSup] = useState(false);

  const reload = useCallback(() => {
    api.getSupplier(id).then(setData).catch(() => {});
  }, [id]);
  useEffect(() => { reload(); }, [reload]);

  if (!data) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="sale-head">
          <h2>{data.supplier.name}</h2>
          <button className="btn btn--ghost" onClick={() => setEditSup(true)}>Изменить</button>
        </div>
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
      {editSup && (
        <EditSupplier
          supplier={data.supplier}
          onClose={() => setEditSup(false)}
          onDone={() => { setEditSup(false); reload(); onChange(); onFlash('Поставщик изменён'); }}
        />
      )}
    </div>
  );
}

// Правка справочных данных поставщика: имя и телефон. Долги/платежи не трогаем.
function EditSupplier({ supplier, onClose, onDone }: {
  supplier: { id: string; name: string; phone: string | null }; onClose: () => void; onDone: () => void;
}) {
  const [name, setName] = useState(supplier.name);
  const [phone, setPhone] = useState(supplier.phone ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) { setErr('Укажите имя'); return; }
    setBusy(true); setErr(null);
    try {
      await api.updateSupplier(supplier.id, { name: name.trim(), phone: phone.trim() });
      onDone();
    } catch (e: any) { setErr(e?.body?.error || e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Изменить поставщика</h2>
        <label className="field"><span>Название / имя</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="field"><span>Телефон</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="необязательно" />
        </label>
        {err && <div className="change change--neg">{err}</div>}
        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}

type PaySource = 'cash' | 'wallet' | 'hand' | 'external';

// Варианты «откуда деньги» для оплаты поставщику — с суммами, что там есть.
function payOptions(m: MoneyPlaces | null): SourceOption<PaySource>[] {
  return [
    { value: 'cash', title: 'Из кассы · нал', sub: tillSub(m, 'cash'), disabled: !!m && m.tillCash <= 0 },
    { value: 'wallet', title: 'Из кассы · безнал', sub: tillSub(m, 'wallet'), disabled: !!m && m.tillWallet <= 0 },
    { value: 'hand', title: 'С рук (подотчёт)', sub: m ? `у вас на руках ${money(m.onHand)}` : undefined, disabled: !!m && m.onHand <= 0 },
    { value: 'external', title: 'Со стороны', sub: 'личные деньги, банк — не из магазина' },
  ];
}

function payHint(source: PaySource | null): string | null {
  if (source === 'external') return 'Деньги не из магазина (банк/личные). Ни кассу, ни «на руках» не трогает — только гасит долг.';
  if (source === 'hand') return 'Платим из денег, ранее изъятых из кассы на руки. Кассу не трогает, уменьшает «на руках».';
  if (source === 'cash' || source === 'wallet') return 'Деньги уходят из кассового ящика — касса уменьшится. В прибыль как расход не идёт (товар уже в себестоимости).';
  return null;
}

function AddInvoice({ supplierId, onClose, onDone }: { supplierId: string; onClose: () => void; onDone: () => void }) {
  const [total, setTotal] = useState('');
  const [paid, setPaid] = useState('');
  const [note, setNote] = useState('');
  const [source, setSource] = useState<PaySource | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const places = useMoneyPlaces(true);

  const debt = (Number(total) || 0) - (Number(paid) || 0);
  const paidNow = (Number(paid) || 0) > 0;

  async function save() {
    const t = Number(total) || 0;
    const p = Number(paid) || 0;
    if (!(t > 0)) { setErr('Укажите сумму накладной'); return; }
    if (p > t) { setErr('Оплачено больше суммы накладной'); return; }
    if (p > 0 && !source) { setErr('Выберите, откуда деньги на оплату'); return; }
    setBusy(true); setErr(null);
    try {
      await api.addInvoice(supplierId, { total: t, paid: p, note: note.trim() || undefined, source: p > 0 ? source! : undefined });
      onDone();
    } catch (e: any) { setErr(e?.body?.error || e?.body?.message || e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--scroll" onClick={(e) => e.stopPropagation()}>
        <h2>Новая накладная</h2>
        <div className="row">
          <label className="field"><span>Сумма накладной</span><NumberInput value={total} onValue={setTotal} autoFocus /></label>
          <label className="field"><span>Оплатили сейчас</span><NumberInput value={paid} onValue={setPaid} placeholder="0" /></label>
        </div>
        {paidNow && (
          <>
            <SourcePicker label="Откуда деньги на оплату" value={source} onChange={setSource} options={payOptions(places)} />
            {payHint(source) && <p className="hint">{payHint(source)}</p>}
          </>
        )}
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
          <button className="btn btn--primary" onClick={save} disabled={busy || (paidNow && !source)}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}

function PayInvoice({ invoice, onClose, onDone }: { invoice: any; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  // Заранее ничего не выбрано — откуда деньги, нажимают сами.
  const [source, setSource] = useState<PaySource | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const places = useMoneyPlaces(true);
  const remaining = Number(invoice.remaining);

  async function save() {
    const a = Number(amount) || 0;
    if (!(a > 0)) { setErr('Укажите сумму'); return; }
    if (a > remaining) { setErr(`Осталось всего ${remaining.toFixed(2)}`); return; }
    if (!source) { setErr('Выберите, откуда деньги'); return; }
    setBusy(true); setErr(null);
    try {
      await api.payInvoice(invoice.id, { amount: a, note: note.trim() || undefined, source });
      onDone();
    } catch (e: any) { setErr(e?.body?.error || e?.body?.message || e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--scroll" onClick={(e) => e.stopPropagation()}>
        <h2>Оплата поставщику</h2>
        <p className="muted">По накладной осталось: <b>{remaining.toFixed(2)}</b></p>

        <SourcePicker value={source} onChange={setSource} options={payOptions(places)} />
        {payHint(source) && <p className="hint">{payHint(source)}</p>}

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
          <button className="btn btn--primary" onClick={save} disabled={busy || !source}>Внести платёж</button>
        </div>
      </div>
    </div>
  );
}
