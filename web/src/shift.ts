import { useEffect, useState } from 'react';
import { api } from './api';

// Состояние текущей смены. Общий стор для экрана продажи и экрана смены.
const CACHE_KEY = 'kassa_shift';

function readCache(): any | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let current: any | null = readCache();
let loaded = false;

type Listener = () => void;
const listeners = new Set<Listener>();
function notify() {
  listeners.forEach((l) => l());
}

export async function refreshShift() {
  try {
    const { shift } = await api.currentShift();
    current = shift;
    // Помним последнюю известную смену: при обрыве сети касса продолжает
    // работать, а не показывает «смена закрыта» (п.8 ТЗ).
    if (shift) localStorage.setItem(CACHE_KEY, JSON.stringify(shift));
    else localStorage.removeItem(CACHE_KEY);
  } catch (err: any) {
    if (err?.status === undefined) {
      // Сети нет — оставляем то, что знали. Кассир продолжает продавать,
      // чеки уйдут в очередь и доедут в эту же смену.
      if (!current) current = readCache();
    } else {
      // Сервер ответил (401/403) — смены действительно нет.
      current = null;
      localStorage.removeItem(CACHE_KEY);
    }
  }
  loaded = true;
  notify();
}

// Возвращает { shift } при успехе или { pending, request } если нужно
// подтверждение владельца (расхождение). Смену в стор кладём только реально
// открытую.
export async function openShift(openingCash: number, openingWallet: number) {
  const res = await api.openShift(openingCash, openingWallet);
  if (res.pending) return { pending: true, request: res.request, message: res.message };
  current = res.shift;
  localStorage.setItem(CACHE_KEY, JSON.stringify(res.shift));
  notify();
  return { shift: res.shift };
}

export async function closeShift(countedCash: number, countedWallet: number, userId?: string) {
  const res = await api.closeShift(countedCash, countedWallet, userId);
  if (res.pending) return { pending: true, request: res.request, message: res.message };
  if (!userId) { current = null; localStorage.removeItem(CACHE_KEY); } // закрыли свою смену
  notify();
  return { shift: res.shift }; // закрытая смена с расчётом расхождения
}

// Выход пользователя: смена и её кэш не должны достаться следующему.
export function resetShift() {
  current = null;
  loaded = false;
  localStorage.removeItem(CACHE_KEY);
  notify();
}

export function getShift() {
  return current;
}

// Хук: { shift, loaded }.
export function useShift(): { shift: any | null; loaded: boolean } {
  const [state, setState] = useState({ shift: current, loaded });
  useEffect(() => {
    const l = () => setState({ shift: current, loaded });
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return state;
}
