/**
 * Landing page — shown to unauthenticated users.
 * Login and register are toggled in-page; no separate route needed.
 */
import { useState, type FormEvent } from "react";
import { useAuth } from "../contexts/AuthContext";
import { isFirebaseConfigured } from "../lib/firebase";

export default function Landing() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await signIn(email, password);
      } else {
        await signUp(email, password);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-[#07070f] flex flex-col items-center justify-center overflow-hidden select-none">
      {/* ── ambient glow blobs ───────────────────────────────────────────── */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 -left-40 w-[600px] h-[600px]
                   rounded-full bg-purple-900/20 blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-60 right-0 w-[500px] h-[500px]
                   rounded-full bg-indigo-900/15 blur-[100px]"
      />

      {/* ── logo / hero ──────────────────────────────────────────────────── */}
      <div className="relative z-10 flex flex-col items-center gap-3 mb-12">
        <div className="flex items-baseline gap-1">
          <span className="text-6xl font-black tracking-tighter text-white">
            Beat
          </span>
          <span className="text-6xl font-black tracking-tighter text-purple-400">
            Bot
          </span>
        </div>

        <p className="text-gray-400 text-base tracking-[0.25em] uppercase text-sm font-medium">
          The AI&nbsp;DJ
        </p>

        <p className="mt-2 text-gray-600 text-sm text-center max-w-xs leading-relaxed">
          Point to your local music library. BeatBot analyses your tracks and
          mixes them — automatically, musically, endlessly.
        </p>

        {/* Dev-mode pill */}
        {!isFirebaseConfigured && (
          <div className="mt-1 px-3 py-1 rounded-full bg-yellow-900/30 border border-yellow-700/40 text-yellow-500 text-xs">
            Dev mode — accounts stored locally
          </div>
        )}
      </div>

      {/* ── auth card ────────────────────────────────────────────────────── */}
      <div
        className="relative z-10 w-full max-w-sm
                   bg-white/[0.03] border border-white/10 rounded-2xl p-8
                   backdrop-blur-sm shadow-2xl shadow-black/60"
      >
        {/* Tab switcher */}
        <div className="flex mb-6 gap-0 rounded-lg bg-white/[0.04] p-1">
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
                mode === m
                  ? "bg-purple-600 text-white shadow"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {m === "login" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Email */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-gray-500 uppercase tracking-widest">
              Email
            </label>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="bg-white/[0.05] border border-white/10 rounded-lg px-4 py-2.5
                         text-white text-sm placeholder:text-gray-700
                         focus:outline-none focus:ring-2 focus:ring-purple-500/50
                         transition-all"
            />
          </div>

          {/* Password */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-gray-500 uppercase tracking-widest">
              Password
            </label>
            <input
              type="password"
              required
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="bg-white/[0.05] border border-white/10 rounded-lg px-4 py-2.5
                         text-white text-sm placeholder:text-gray-700
                         focus:outline-none focus:ring-2 focus:ring-purple-500/50
                         transition-all"
            />
          </div>

          {/* Error */}
          {error && (
            <p
              className="text-red-400 text-xs bg-red-900/20 border border-red-800/40
                          rounded-lg px-3 py-2"
            >
              {error}
            </p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={busy}
            className="mt-1 w-full py-3 rounded-xl font-semibold text-sm
                       bg-purple-600 hover:bg-purple-500 active:bg-purple-700
                       text-white transition-all shadow-lg shadow-purple-900/40
                       disabled:opacity-50 disabled:cursor-wait
                       flex items-center justify-center gap-2"
          >
            {busy ? (
              <>
                <span
                  className="w-4 h-4 border-2 border-white/30 border-t-white
                                 rounded-full animate-spin"
                />
                <span>
                  {mode === "login" ? "Signing in…" : "Creating account…"}
                </span>
              </>
            ) : mode === "login" ? (
              "Sign in →"
            ) : (
              "Create account →"
            )}
          </button>
        </form>
      </div>

      {/* Footer note */}
      <p className="relative z-10 mt-8 text-gray-700 text-xs text-center">
        Your music never leaves your device.
      </p>
    </div>
  );
}
