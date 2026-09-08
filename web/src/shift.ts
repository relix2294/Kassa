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

export async function openShift(openingCash: number) {
  const { shift } = await api.openShift(openingCash);
  current = shift;
  localStorage.setItem(CACHE_KEY, JSON.stringify(shift));
  notify();
  return shift;
}

export async function closeShift(countedCash: number, userId?: string) {
  const { shift } = await api.closeShift(countedCash, userId);
  if (!userId) current = null; // закрыли свою смену
  if (!userId) localStorage.removeItem(CACHE_KEY);
  notify();
  return shift; // закрытая смена с расчётом расхождения
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
