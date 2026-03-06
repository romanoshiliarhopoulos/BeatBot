/**
 * MixContext — manages user-defined mixes (ordered subsets of library tracks).
 * Persisted to localStorage so mixes survive page refreshes.
 */
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import type { Mix } from "../types";

// ── types ──────────────────────────────────────────────────────────────────

interface MixContextValue {
  mixes: Mix[];
  createMix: (name: string, color?: string) => Mix;
  updateMix: (
    id: string,
    updates: Partial<Pick<Mix, "name" | "trackIds" | "color">>,
  ) => void;
  deleteMix: (id: string) => void;
  duplicateMix: (id: string) => Mix;
}

// ── context ────────────────────────────────────────────────────────────────

const MixContext = createContext<MixContextValue | null>(null);

const STORAGE_KEY = "beatbot_mixes";

function loadFromStorage(): Mix[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Mix[];
  } catch {
    return [];
  }
}

export function MixProvider({ children }: { children: ReactNode }) {
  const [mixes, setMixes] = useState<Mix[]>(loadFromStorage);

  // Sync to localStorage whenever mixes change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mixes));
    } catch {
      /* storage full or unavailable */
    }
  }, [mixes]);

  const createMix = useCallback((name: string, color?: string): Mix => {
    const mix: Mix = {
      id: crypto.randomUUID(),
      name: name.trim() || "New Mix",
      color: color ?? "purple",
      trackIds: [],
      createdAt: Date.now(),
    };
    setMixes((prev) => [...prev, mix]);
    return mix;
  }, []);

  const updateMix = useCallback(
    (
      id: string,
      updates: Partial<Pick<Mix, "name" | "trackIds" | "color">>,
    ) => {
      setMixes((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...updates } : m)),
      );
    },
    [],
  );

  const deleteMix = useCallback((id: string) => {
    setMixes((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const duplicateMix = useCallback(
    (id: string): Mix => {
      const source = mixes.find((m) => m.id === id);
      if (!source) throw new Error(`Mix ${id} not found`);
      const copy: Mix = {
        ...source,
        id: crypto.randomUUID(),
        name: `${source.name} (copy)`,
        createdAt: Date.now(),
      };
      setMixes((prev) => [...prev, copy]);
      return copy;
    },
    [mixes],
  );

  return (
    <MixContext.Provider
      value={{ mixes, createMix, updateMix, deleteMix, duplicateMix }}
    >
      {children}
    </MixContext.Provider>
  );
}

export function useMixes() {
  const ctx = useContext(MixContext);
  if (!ctx) throw new Error("useMixes must be used within MixProvider");
  return ctx;
}
