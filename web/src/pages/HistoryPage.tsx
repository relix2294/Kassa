import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { onRealtimeEvent } from '../sync';

// Хронология чеков: каждая продажа по времени, с раскрытием состава
// (что внутри, сколько, по какой цене), кассиром и разбивкой оплаты.
// Только для владельца; на VPS-витрине работает как есть (только чтение).

type Period = 'today' | 'week' | 'month' | 'all';

const PERIOD_LABEL: Record<Period, string> = {
  today: 'Сегодня',
  week: 'Неделя',
  month: 'Месяц',
  all: 'Всё время',
};

const PAGE = 30;

type Sale = Awaited<ReturnType<typeof api.salesHistory>>[number];

// Начало периода в ISO. Всё считаем по времени этого устройства — для
// хронологии владельцу этого достаточно.
function periodFrom(p: Period): string | undefined {
  if (p === 'all') return undefined;
  const d = new Date();
  if (p === 'today') d.setHours(0, 0, 0, 0);
  else if (p === 'week') d.setDate(d.getDate() - 7);
  else if (p === 'month') d.setDate(d.getDate() - 30);
  return d.toISOString();
}

const METHOD: Record<string, string> = { cash: '💵 Наличные', card: '💳 Карта', mixed: '💵➕💳 Смешанная' };

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export default function HistoryPage() {
  const [period, setPeriod] = useState<Period>('today');
  const [cashier, setCashier] = useState<string>('');
  const [staff, setStaff] = useState<{ id: string; username: string; full_name?: string | null }[]>([]);
  const [rows, setRows] = useState<Sale[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false); // больше страниц нет

  // Список кассиров для фильтра (необязательно — если недоступно, просто нет фильтра).
  useEffect(() => {
    api.listUsers().then((u) => setStaff(u)).catch(() => {});
  }, []);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.salesHistory({
        from: periodFrom(period),
        cashier: cashier || undefined,
        limit: PAGE,
        offset: 0,
      });
      setRows(data);
      setDone(data.length < PAGE);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [period, cashier]);

  useEffect(() => {
    loadFirst();
  }, [loadFirst]);

  // Новая продажа/приход снимка на витрине — обновим первую страницу.
  useEffect(
    () => onRealtimeEvent((t) => (t === 'sale' || t === 'data_updated') && loadFirst()),
    [loadFirst],
  );

  async function loadMore() {
    setLoading(true);
    try {
      const data = await api.salesHistory({
        from: periodFrom(period),
        cashier: cashier || undefined,
        limit: PAGE,
        offset: rows.length,
      });
      setRows((prev) => [...prev, ...data]);
      if (data.length < PAGE) setDone(true);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <h1>Чеки</h1>

      <div className="seg">
        {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
          <button key={p} className={`seg__btn ${period === p ? 'seg__btn--on' : ''}`} onClick={() => setPeriod(p)}>
            {PERIOD_LABEL[p]}
          </button>
        ))}
      </div>

      {staff.length > 0 && (
        <label className="field">
          <span>Кассир</span>
          <select className="search" value={cashier} onChange={(e) => setCashier(e.target.value)}>
            <option value="">Все</option>
            {staff.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name || u.username}
              </option>
            ))}
          </select>
        </label>
      )}

      {rows.length === 0 && !loading && <p className="hint">За выбранный период чеков нет.</p>}

      <div className="list">
        {rows.map((s) => {
          const open = openId === s.id;
          const margin = Number((Number(s.total) - Number(s.cost_total)).toFixed(2));
          return (
            <div key={s.id} className="receipt">
              <button className="receipt__head" onClick={() => setOpenId(open ? null : s.id)}>
                <div className="receipt__main">
                  <div className="receipt__title">
                    {fmtTime(s.created_at)}
                    <span className="muted"> · {s.full_name || s.username || 'кассир?'}</span>
                  </div>
                  <div className="muted">
                    {METHOD[s.payment_method] || s.payment_method} · {s.items.length} поз. {open ? '▲' : '▼'}
                  </div>
                </div>
                <div className="receipt__sum">{Number(s.total).toFixed(2)}</div>
              </button>

              {open && (
                <div className="receipt__body">
                  {s.items.map((it, i) => (
                    <div key={i} className="receipt__line">
                      <span className="receipt__name">{it.name}</span>
                      <span className="muted">
                        {Number(it.qty)} × {Number(it.unit_price)} = <b>{Number(it.line_total).toFixed(2)}</b>
                      </span>
                    </div>
                  ))}
                  <div className="receipt__foot">
                    <Row label="Итого" value={`${Number(s.total).toFixed(2)}`} strong />
                    {Number(s.cash_amount) > 0 && <Row label="Наличными" value={Number(s.cash_amount).toFixed(2)} />}
                    {Number(s.card_amount) > 0 && <Row label="Картой" value={Number(s.card_amount).toFixed(2)} />}
                    {s.change_given != null && Number(s.change_given) > 0 && (
                      <Row label="Сдача" value={Number(s.change_given).toFixed(2)} />
                    )}
                    <Row label="Прибыль" value={margin.toFixed(2)} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!done && rows.length > 0 && (
        <button className="btn btn--ghost" disabled={loading} onClick={loadMore}>
          {loading ? 'Загрузка…' : 'Показать ещё'}
        </button>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="receipt__row">
      <span className="muted">{label}</span>
      {strong ? <b>{value}</b> : <span>{value}</span>}
    </div>
  );
}
