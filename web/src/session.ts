import { useAuth } from './auth';
import type { User } from './types';

// Текущий пользователь берётся из авторизации (этап 3).
export function useCurrentUser(): User | null {
  return useAuth();
}
