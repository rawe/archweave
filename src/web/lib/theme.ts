import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'archweave.theme';
const media = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = new Set<() => void>();

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function current(): Theme {
  return stored() ?? (media?.matches ? 'dark' : 'light');
}

function apply() {
  document.documentElement.dataset.theme = current();
  listeners.forEach((l) => l());
}

media?.addEventListener('change', () => {
  if (!stored()) apply();
});

export function toggleTheme() {
  const next: Theme = current() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* storage unavailable */
  }
  apply();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    current,
  );
}

apply();
