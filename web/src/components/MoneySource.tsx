import { useEffect, useState } from 'react';
import { api } from '../api';
import { money } from './RangeControl';
import { useCurrentUser } from '../session';

export interface MoneyPlaces { tillCash: number; tillWallet: number; tillOpen: boolean; onHand: number }

// Сколько денег сейчас в кассе и у меня на руках — подсказка на кнопках выбора
// «откуда деньги» (только владельцу: баланс — его раздел).
export function useMoneyPlaces(enabled: boolean): MoneyPlaces | null {
  const user = useCurrentUser();
  const [m, setM] = useState<MoneyPlaces | null>(null);
  useEffect(() => {
    if (!enabled) return;
    api.balance().then((b) => setM({
      tillCash: b.till.cash,
      tillWallet: b.till.wallet,
      tillOpen: b.till.has_open_shift,
      onHand: b.hands.find((h) => h.user_id === user?.id)?.on_hand ?? 0,
    })).catch(() => {});
  }, [enabled, user?.id]);
  return m;
}

// Подпись кассы: открыта смена или закрытый ящик.
export function tillSub(m: MoneyPlaces | null, kind?: 'cash' | 'wallet'): string | undefined {
  if (!m) return undefined;
  const where = m.tillOpen ? 'в кассе' : 'смена закрыта, в ящике';
  if (kind === 'cash') return `${where} ${money(m.tillCash)}`;
  if (kind === 'wallet') return `${where} ${money(m.tillWallet)}`;
  return `${where}: нал ${money(m.tillCash)} · безнал ${money(m.tillWallet)}`;
}

export interface SourceOption<T extends string> { value: T; title: string; sub?: string; disabled?: boolean }

// Выбор «откуда деньги». Значения по умолчанию НЕТ: человек нажимает сам —
// иначе по привычке жмут первое и списывают не оттуда, откуда взяли деньги.
export function SourcePicker<T extends string>({ label = 'Откуда деньги', options, value, onChange }: {
  label?: string;
  options: SourceOption<T>[];
  value: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="src-pick">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={o.disabled}
            className={`src-pick__opt ${value === o.value ? 'src-pick__opt--on' : ''}`}
            onClick={() => onChange(o.value)}
          >
            <b>{o.title}</b>
            {o.sub && <span>{o.sub}</span>}
          </button>
        ))}
      </div>
      {!value && <span className="src-pick__need">Выберите вручную — заранее ничего не выбрано</span>}
    </div>
  );
}
