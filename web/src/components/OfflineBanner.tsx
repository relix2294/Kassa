import { useEffect, useState } from 'react';
import { isOnline, offlineSince, onOnlineChange, onQueueChange, queueStats } from '../sync';

// Короткие обрывы (переподключение WebSocket, перезапуск сервера) не должны
// мигать плашкой перед кассиром — показываем её, только если связи нет дольше.
const SHOW_AFTER = 3000;
// Дольше этого — плашка краснеет: пора звонить владельцу / проверять роутер.
const LONG_OFFLINE = 5 * 60 * 1000;
// Сколько висит зелёное «связь восстановлена».
const RESTORED_FOR = 4000;

// Состояние связи для компонентов. Перечитываем его при подписке: если связь
// пропала между первым рендером и подпиской (касса стартовала без сети),
// событие уже прошло, и без этого значок навсегда остался бы «онлайн».
export function useOnline() {
  const [online, setOnline] = useState(isOnline);
  useEffect(() => {
    setOnline(isOnline);
    return onOnlineChange(() => setOnline(isOnline));
  }, []);
  return online;
}

function minutesAgo(ts: number) {
  const m = Math.floor((Date.now() - ts) / 60000);
  return m < 1 ? 'меньше минуты' : `${m} мин`;
}

// Большая плашка под шапкой: кассир должен заметить обрыв связи сразу,
// а не по маленькому значку в углу.
export default function OfflineBanner() {
  const online = useOnline();
  const [shown, setShown] = useState(false);
  const [restored, setRestored] = useState(false);
  const [pending, setPending] = useState(0);
  const [, tick] = useState(0);

  useEffect(() => {
    if (online) {
      if (shown) {
        setShown(false);
        setRestored(true);
        const t = setTimeout(() => setRestored(false), RESTORED_FOR);
        return () => clearTimeout(t);
      }
      return;
    }
    setRestored(false);
    const t = setTimeout(() => setShown(true), SHOW_AFTER);
    return () => clearTimeout(t);
  }, [online]);

  // Пока плашка видна — обновляем «сколько минут без связи» и очередь.
  useEffect(() => {
    if (!shown) return;
    const load = () => queueStats().then((s) => setPending(s.pending)).catch(() => {});
    load();
    const off = onQueueChange(load);
    const t = setInterval(() => tick((n) => n + 1), 15000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [shown]);

  if (restored) {
    return (
      <div className="net-banner net-banner--ok" role="status">
        <span className="net-banner__icon">✓</span>
        <div className="net-banner__text">
          <b>Связь восстановлена</b>
          <span>Сохранённые продажи отправляются на сервер.</span>
        </div>
      </div>
    );
  }

  if (!shown) return null;

  const long = offlineSince !== null && Date.now() - offlineSince > LONG_OFFLINE;
  return (
    <div className={`net-banner ${long ? 'net-banner--danger' : 'net-banner--warn'}`} role="alert">
      <span className="net-banner__icon">⚠</span>
      <div className="net-banner__text">
        <b>
          Нет связи с сервером
          {offlineSince !== null && ` · ${minutesAgo(offlineSince)}`}
        </b>
        <span>
          Проверьте интернет. Продавать можно: чеки сохраняются на кассе
          {pending > 0 ? ` (ждут отправки: ${pending})` : ''} и уйдут сами, когда связь появится.
          {long && ' Если связь не вернулась — сообщите владельцу.'}
        </span>
      </div>
    </div>
  );
}
