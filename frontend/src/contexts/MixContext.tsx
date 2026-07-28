/**
 * MixContext — manages user-defined mixes, persisted to Firestore via the API.
 *
 * Strategy: optimistic local state
 *   - On mount: fetch mixes from GET /mixes and populate local state.
 *   - createMix / updateMix / deleteMix / duplicateMix mutate local state
 *     immediately (synchronous, so callers don't need to await) and fire the
 *     corresponding API call in the background.
 *   - On API failure the error is logged; a refetch is triggered to restore
 *     the correct server state.
 *
 * The context value interface is unchanged from the localStorage version so
 * all existing consumers (Library.tsx, Queue.tsx, DJEnvironment.tsx, etc.)
 * work without modification.
 */
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Mix } from "../types";
import {
  fetchMixes,
  apiCreateMix,
  apiUpdateMix,
  apiDeleteMix,
} from "../api/client";
import { useAuth } from "./AuthContext";

// ── types ──────────────────────────────────────────────────────────────────

interface MixContextValue {
  mixes: Mix[];
  isLoading: boolean;
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

export function MixProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { user, loading: authLoading } = useAuth();

  //console.log(
  //  "[MixContext] auth state — user:",
  //  user?.uid ?? null,
  //  "authLoading:",
  //  authLoading,
  //);

  // Server state — only fetch once auth has resolved and user is signed in.
  const { data: serverMixes, isLoading } = useQuery<Mix[]>({
    queryKey: ["mixes"],
    queryFn: fetchMixes,
    staleTime: 60_000,
    enabled: !authLoading && !!user,
  });

  console.log(
    "[MixContext] query state — isLoading:",
    isLoading,
    "serverMixes:",
    serverMixes,
  );

  // Optimistic local overlay. Always tracks the latest server state.
  const [mixes, setMixes] = useState<Mix[]>([]);

  // Sync local state whenever the server returns fresh data.
  useEffect(() => {
    //console.log("[MixContext] serverMixes changed:", serverMixes);
    if (serverMixes !== undefined) {
      console.log(
        "[MixContext] seeding local mixes with",
        serverMixes.length,
        "items",
      );
      setMixes(serverMixes);
    }
  }, [serverMixes]);

  // Reset when user signs out or changes.
  useEffect(() => {
    if (!user) {
      //console.log("[MixContext] user signed out — clearing mixes");
      setMixes([]);
    }
  }, [user]);

  // Refetch helper — called on API failure to restore correct server state.
  const refetch = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["mixes"] }).then(() => {
      qc.fetchQuery<Mix[]>({ queryKey: ["mixes"], queryFn: fetchMixes })
        .then((fresh) => setMixes(fresh))
        .catch(() => {});
    });
  }, [qc]);

  // ── createMix ──────────────────────────────────────────────────────────

  const createMix = useCallback((name: string, color?: string): Mix => {
    const mix: Mix = {
      id: crypto.randomUUID(),
      name: name.trim() || "New Mix",
      color: color ?? "purple",
      trackIds: [],
      createdAt: Date.now(),
    };
    //console.log("[MixContext] createMix optimistic add:", mix);
    setMixes((prev) => [...prev, mix]);
    apiCreateMix(mix)
      .then((res) => console.log("[MixContext] createMix API success:", res))
      .catch((err) => {
        console.error("[MixContext] createMix failed:", err);
        setMixes((prev) => prev.filter((m) => m.id !== mix.id));
      });
    return mix;
  }, []);

  // ── updateMix ──────────────────────────────────────────────────────────

  const updateMix = useCallback(
    (
      id: string,
      updates: Partial<Pick<Mix, "name" | "trackIds" | "color">>,
    ) => {
      setMixes((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...updates } : m)),
      );
      apiUpdateMix(id, updates).catch((err) => {
        console.error("[MixContext] updateMix failed:", err);
        refetch();
      });
    },
    [refetch],
  );

  // ── deleteMix ──────────────────────────────────────────────────────────

  const deleteMix = useCallback(
    (id: string) => {
      setMixes((prev) => prev.filter((m) => m.id !== id));
      apiDeleteMix(id).catch((err) => {
        console.error("[MixContext] deleteMix failed:", err);
        refetch();
      });
    },
    [refetch],
  );

  // ── duplicateMix ───────────────────────────────────────────────────────

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
      apiCreateMix(copy).catch((err) => {
        console.error("[MixContext] duplicateMix failed:", err);
        setMixes((prev) => prev.filter((m) => m.id !== copy.id));
      });
      return copy;
    },
    [mixes],
  );

  return (
    <MixContext.Provider
      value={{
        mixes,
        isLoading,
        createMix,
        updateMix,
        deleteMix,
        duplicateMix,
      }}
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
