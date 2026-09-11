import { useEffect, useState } from 'react';

// Тема оформления. По умолчанию — «авто»: днём светлый фон, ночью тёмный,
// как просил владелец. Можно зафиксировать вручную.

export type ThemeMode = 'auto' | 'light' | 'dark';
type Resolved = 'light' | 'dark';

const KEY = 'kassa_theme';

// Дневное время — светлая тема. С 7:00 до 19:00.
function byClock(): Resolved {
  const h = new Date().getHours();
  return h >= 7 && h < 19 ? 'light' : 'dark';
}

export function getMode(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'auto';
}

export function resolveTheme(mode: ThemeMode = getMode()): Resolved {
  return mode === 'auto' ? byClock() : mode;
}

let listeners = new Set<() => void>();

export function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme();
  listeners.forEach((l) => l());
}

export function setMode(mode: ThemeMode) {
  if (mode === 'auto') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, mode);
  applyTheme();
}

// Переключение по кругу: авто → светлая → тёмная → авто.
export function cycleMode(): ThemeMode {
  const next: ThemeMode = getMode() === 'auto' ? 'light' : getMode() === 'light' ? 'dark' : 'auto';
  setMode(next);
  return next;
}

export function initTheme() {
  applyTheme();
  // В режиме «авто» тема должна сама переключиться вечером/утром без перезагрузки.
  setInterval(() => {
    if (getMode() === 'auto') applyTheme();
  }, 5 * 60 * 1000);
}

// Хук для кнопки в шапке: текущий режим и его иконка.
export function useThemeMode(): { mode: ThemeMode; icon: string; label: string; cycle: () => void } {
  const [mode, setLocal] = useState<ThemeMode>(getMode());
  useEffect(() => {
    const l = () => setLocal(getMode());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  const icon = mode === 'auto' ? '🌗' : mode === 'light' ? '☀️' : '🌙';
  const label = mode === 'auto' ? 'Авто' : mode === 'light' ? 'День' : 'Ночь';
  return { mode, icon, label, cycle: () => cycleMode() };
}
