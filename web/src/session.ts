import { useEffect, useState } from 'react';
import { api } from './api';
import type { User } from './types';

// Временная «сессия»: до этапа 3 (роли/логин) работаем как владелец.
// Держим текущего пользователя, чтобы привязывать действия в журнале.
let cached: User | null = null;

export function useCurrentUser(): User | null {
  const [user, setUser] = useState<User | null>(cached);
  useEffect(() => {
    if (cached) return;
    api
      .listUsers()
      .then((users) => {
        cached = users.find((u) => u.role === 'owner') ?? users[0] ?? null;
        setUser(cached);
      })
      .catch(() => setUser(null));
  }, []);
  return user;
}
