import { useCallback, useEffect, useState } from 'react';
import type { OutboxItem } from '../db';
import { listFailed, retryFailed, onQueueChange, queueStats } from '../sync';

const KIND_LABEL: Record<string, string> = {
  sale: 'Продажа',
  return: 'Возврат',
  receiving: 'Приём товара',
  create_product: 'Новый товар',
  update_product: 'Изменение товара',
  log_event: 'Событие журнала',
};

function describe(item: OutboxItem): string {
  const p = item.payload ?? {};
  switch (item.kind) {
    case 'sale': {
      const n = p.items?.length ?? 0;
      const pay = p.payment_method === 'cash' ? 'наличные' : 'карта';
      return `${n} поз. · ${pay}${p.cash_received != null ? ` · получено ${p.cash_received}` : ''}`;
    }
    case 'return':
      return `${p.items?.length ?? 0} поз.${p.reason ? ` · ${p.reason}` : ''}`;
    case 'receiving':
      return `${p.barcode} · ${p.qty} шт`;
    case 'create_product':
      return `${p.name ?? ''} · ${p.barcode ?? ''}`;
    default:
      return '';
  }
}

// Операции, которые не удалось отправить на сервер. Мы их не удаляем:
// пропавший чек — это деньги в кассе без записи.
export default function QueuePage() {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    listFailed().then(setItems).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onQueueChange(load), [load]);

  if (items.length === 0) {
    return (
      <div className="page">
        <h1>Проблемные операции</h1>
        <p className="hint">Всё отправлено на сервер — здесь пусто.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Проблемные операции</h1>
      <p className="hint">
        Эти операции не приняты сервером. Они сохранены и никуда не пропадут —
        разберитесь с причиной и повторите отправку.
      </p>

      <div className="list">
        {items.map((i) => (
          <div key={i.id} className="list-item list-item--static list-item--alert">
            <div className="list-item__main">
              <div className="list-item__name">{KIND_LABEL[i.kind] ?? i.kind}</div>
              <div className="muted">
                {new Date(i.createdAt).toLocaleString('ru-RU', {
                  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                })}
                {' · '}
                {describe(i)}
              </div>
              <div className="log-details">Причина: {i.lastError || 'неизвестно'}</div>
            </div>
            <button
              className="btn btn--ghost"
              disabled={busy === i.id}
              onClick={async () => {
                setBusy(i.id!);
                try {
                  await retryFailed(i.id!);
                  load();
                } finally {
                  setBusy(null);
                }
              }}
            >
              Повторить
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Индикатор в шапке: сколько ждёт отправки и сколько застряло.
export function QueueBadge({ onOpen }: { onOpen: () => void }) {
  const [stats, setStats] = useState({ pending: 0, failed: 0 });

  const load = useCallback(() => {
    queueStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => onQueueChange(load), [load]);

  if (stats.failed > 0) {
    return (
      <button className="badge badge--danger" onClick={onOpen} title="Операции не отправлены">
        ⚠ {stats.failed}
      </button>
    );
  }
  if (stats.pending > 0) {
    return <span className="badge badge--off">в очереди: {stats.pending}</span>;
  }
  return null;
}
