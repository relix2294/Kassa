import { useEffect, useState } from 'react';
import type { User } from './types';

// Хранилище авторизации: токен + текущий пользователь. Живёт в localStorage,
// чтобы вход не слетал при перезагрузке кассы.

const TOKEN_KEY = 'kassa_token';
const USER_KEY = 'kassa_user';

let token: string | null = localStorage.getItem(TOKEN_KEY);
let user: User | null = safeParse(localStorage.getItem(USER_KEY));

function safeParse(v: string | null): User | null {
  try {
    return v ? (JSON.parse(v) as User) : null;
  } catch {
    return null;
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();
function notify() {
  listeners.forEach((l) => l());
}

export function getToken() {
  return token;
}
export function getUser() {
  return user;
}

export function setAuth(t: string, u: User) {
  token = t;
  user = u;
  localStorage.setItem(TOKEN_KEY, t);
  localStorage.setItem(USER_KEY, JSON.stringify(u));
  notify();
}

export function logout() {
  token = null;
  user = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  notify();
}

// Хук: возвращает текущего пользователя (или null) и обновляется при входе/выходе.
export function useAuth(): User | null {
  const [u, setU] = useState<User | null>(user);
  useEffect(() => {
    const l = () => setU(user);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return u;
}

export const isOwner = () => user?.role === 'owner';
