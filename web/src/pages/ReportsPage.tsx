import { useCallback, useEffect, useState } from 'react';
import { api, type Range } from '../api';
import RangeControl, { money } from '../components/RangeControl';
import Icon from '../components/Icon';
import { exportXlsx } from '../xlsx';

// Отчёты: сводка за период для учёта и печати. Всё — на готовых данных сервера,
// плюс выгрузка в CSV (Excel) и печать. Удобно отдать бухгалтеру или подшить.
export default function ReportsPage() {
  const [range, setRange] = useState<Range>({ period: '30d' });
  const [s, setS] = useState<any | null>(null);
  const [top, setTop] = useState<any[]>([]);
  const [cats, setCats] = useState<any[]>([]);
  const [exp, setExp] = useState<any[]>([]);
  const [sup, setSup] = useState<any | null>(null);

  const load = useCallback(async () => {
    try {
      const [sum, t, c, e, sp] = await Promise.all([
        api.summary(range), api.topProducts(range, 'revenue', 50),
        api.byCategory(range), api.expensesByCategory(range), api.supplierStats(range),
      ]);
      setS(sum); setTop(t); setCats(c); setExp(e); setSup(sp);
    } catch { /* ignore */ }
  }, [range]);
  useEffect(() => { load(); }, [load]);

  const expTotal = exp.reduce((a, e) => a + Number(e.total), 0);

  async function downloadXlsx() {
    if (!s) return;
    const period = `${new Date(s.from).toLocaleDateString('ru-RU')} — ${new Date(s.to).toLocaleDateString('ru-RU')}`;
    await exportXlsx('kassa-otchet', `Отчёт за период: ${period}`, [
      { caption: 'Сводка', columns: [{ header: 'Показатель' }, { header: 'Значение', num: true }], rows: [
        ['Выручка (за вычетом возвратов)', Number(s.net_revenue)],
        ['Маржа', Number(s.margin)],
        ['Маржа, %', Number(s.margin_pct)],
        ['Чеков', Number(s.receipts)],
        ['Средний чек', Number(s.avg_check)],
        ['Наличные', Number(s.cash)],
        ['Безнал', Number(s.card)],
        ['Возвраты', Number(s.refunds_total)],
        ['Расходы', Number(s.expenses)],
        ['Оплачено поставщикам', Number(sup?.paid ?? 0)],
        ['Чистая прибыль', Number(s.net_profit)],
      ] },
      { caption: 'Топ товаров', columns: [{ header: 'Товар' }, { header: 'Кол-во', num: true }, { header: 'Выручка', num: true }, { header: 'Маржа', num: true }],
        rows: top.map((p) => [p.name, Number(p.qty), Number(p.revenue), Number(p.margin)]) },
      { caption: 'По категориям', columns: [{ header: 'Категория' }, { header: 'Выручка', num: true }, { header: 'Маржа', num: true }],
        rows: cats.map((c) => [c.category, Number(c.revenue), Number(c.margin)]) },
      { caption: 'Расходы по категориям', columns: [{ header: 'Категория' }, { header: 'Сумма', num: true }],
        rows: exp.map((e) => [e.category, Number(e.total)]) },
      { caption: 'Поставщики', columns: [{ header: 'Показатель' }, { header: 'Сумма', num: true }], rows: [
        ['Оплачено всего', Number(sup?.paid ?? 0)],
        ['Из кассы', Number((sup?.paid_cash ?? 0) + (sup?.paid_wallet ?? 0))],
        ['С рук (подотчёт)', Number(sup?.paid_hand ?? 0)],
        ['Со стороны', Number(sup?.paid_external ?? 0)],
        ['Закуплено (накладные)', Number(sup?.purchased ?? 0)],
      ] },
    ]);
  }

  return (
    <div className="page page--wide">
      <h1>Отчёты</h1>
      <RangeControl range={range} onChange={setRange} />

      <div className="dash-actions no-print">
        <button className="btn btn--ghost" onClick={downloadXlsx} disabled={!s}><Icon name="download" /> Скачать Excel</button>
        <button className="btn btn--ghost" onClick={() => window.print()} disabled={!s}><Icon name="printer" /> Печать</button>
      </div>

      {s && (
        <>
          <div className="kpi-grid">
            <Kpi label="Выручка" value={money(s.net_revenue)} big />
            <Kpi label={`Маржа · ${s.margin_pct}%`} value={money(s.margin)} big accent />
            <Kpi label="Чистая прибыль" value={money(s.net_profit)} big accent />
            <Kpi label="Чеков" value={String(s.receipts)} />
            <Kpi label="Средний чек" value={money(s.avg_check)} />
            <Kpi label="Наличные" value={money(s.cash)} />
            <Kpi label="Безнал" value={money(s.card)} />
            <Kpi label="Возвраты" value={money(s.refunds_total)} danger={s.refunds_total > 0} />
            <Kpi label="Расходы" value={money(s.expenses)} danger={s.expenses > 0} />
            <Kpi label="Оплачено поставщикам" value={money(sup?.paid ?? 0)} />
          </div>

          <h2 className="sect">Топ товаров</h2>
          <Table head={['Товар', 'Кол-во', 'Выручка', 'Маржа']}
                 rows={top.map((p) => [p.name, String(Number(p.qty)), money(p.revenue), money(p.margin)])} />

          <h2 className="sect">По категориям</h2>
          <Table head={['Категория', 'Выручка', 'Маржа']}
                 rows={cats.map((c) => [c.category, money(c.revenue), money(c.margin)])} />

          <h2 className="sect">Расходы по категориям <span className="muted">· всего {money(expTotal)}</span></h2>
          {exp.length === 0
            ? <p className="hint">Расходов за период не было.</p>
            : <Table head={['Категория', 'Сумма']} rows={exp.map((e) => [e.category, money(e.total)])} />}

          <h2 className="sect">Поставщики</h2>
          <Table head={['Показатель', 'Сумма']} rows={[
            ['Оплачено всего', money(sup?.paid ?? 0)],
            ['Из кассы', money((sup?.paid_cash ?? 0) + (sup?.paid_wallet ?? 0))],
            ['С рук (подотчёт)', money(sup?.paid_hand ?? 0)],
            ['Со стороны', money(sup?.paid_external ?? 0)],
            ['Закуплено (накладные)', money(sup?.purchased ?? 0)],
          ]} />
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, big, accent, danger }: { label: string; value: string; big?: boolean; accent?: boolean; danger?: boolean }) {
  return (
    <div className={`kpi ${big ? 'kpi--big' : ''}`}>
      <div className="kpi__label">{label}</div>
      <div className={`kpi__value ${accent ? 'kpi__value--accent' : ''} ${danger ? 'kpi__value--danger' : ''}`}>{value}</div>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  if (rows.length === 0) return <p className="hint">Нет данных.</p>;
  return (
    <div className="report-table-wrap">
      <table className="report-table">
        <thead>
          <tr>{head.map((h, i) => <th key={i} className={i === 0 ? '' : 'num'}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className={j === 0 ? '' : 'num'}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
