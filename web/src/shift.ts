import { useEffect, useState } from 'react';
import { api } from './api';

// Состояние текущей смены. Общий стор для экрана продажи и экрана смены.
let current: any | null = null;
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
  } catch {
    current = null;
  }
  loaded = true;
  notify();
}

export async function openShift(openingCash: number) {
  const { shift } = await api.openShift(openingCash);
  current = shift;
  notify();
  return shift;
}

export async function closeShift(countedCash: number) {
  const { shift } = await api.closeShift(countedCash);
  current = null; // смена закрыта
  notify();
  return shift; // закрытая смена с расчётом расхождения
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
