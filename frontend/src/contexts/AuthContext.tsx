/**
 * Auth context — wraps Firebase auth when configured, otherwise uses a
 * localStorage-based dev-mode session so you can run locally without a
 * Firebase project.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  onAuthStateChanged,
  type User,
} from "firebase/auth";
import { isFirebaseConfigured, firebaseAuth } from "../lib/firebase";

// ── types ──────────────────────────────────────────────────────────────────

/** A minimal user shape that works for both Firebase and dev-mode. */
export interface AppUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

interface AuthContextValue {
  user: AppUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

// ── dev-mode local auth ────────────────────────────────────────────────────

const DEV_USERS_KEY = "beatbot_dev_users";
const DEV_SESSION_KEY = "beatbot_dev_session";

type DevUserRecord = { uid: string; email: string; passwordHash: string };

function devHash(s: string): string {
  // Not crypto-secure — just for offline dev
  let h = 0;
  for (let i = 0; i < s.length; i++)
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}

function devGetUsers(): DevUserRecord[] {
  try {
    return JSON.parse(localStorage.getItem(DEV_USERS_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function devSaveUsers(users: DevUserRecord[]) {
  localStorage.setItem(DEV_USERS_KEY, JSON.stringify(users));
}
function devGetSession(): AppUser | null {
  try {
    return JSON.parse(localStorage.getItem(DEV_SESSION_KEY) ?? "null");
  } catch {
    return null;
  }
}
function devSaveSession(u: AppUser | null) {
  localStorage.setItem(DEV_SESSION_KEY, JSON.stringify(u));
}

async function devSignUp(email: string, password: string): Promise<AppUser> {
  const users = devGetUsers();
  if (users.some((u) => u.email === email))
    throw new Error("Email already in use");
  const uid = `dev-${Date.now()}`;
  users.push({ uid, email, passwordHash: devHash(password) });
  devSaveUsers(users);
  const appUser: AppUser = { uid, email, displayName: null };
  devSaveSession(appUser);
  return appUser;
}

async function devSignIn(email: string, password: string): Promise<AppUser> {
  const users = devGetUsers();
  const found = users.find(
    (u) => u.email === email && u.passwordHash === devHash(password),
  );
  if (!found) throw new Error("Invalid email or password");
  const appUser: AppUser = {
    uid: found.uid,
    email: found.email,
    displayName: null,
  };
  devSaveSession(appUser);
  return appUser;
}

async function devSignOut() {
  devSaveSession(null);
}

// ── context ────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  // ── initialise ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (isFirebaseConfigured && firebaseAuth) {
      // Firebase auth: listens for token changes and persists across reloads
      const unsub = onAuthStateChanged(firebaseAuth, (fbUser: User | null) => {
        if (fbUser) {
          setUser({
            uid: fbUser.uid,
            email: fbUser.email,
            displayName: fbUser.displayName,
          });
        } else {
          setUser(null);
        }
        setLoading(false);
      });
      return unsub;
    } else {
      // Dev mode: read from localStorage synchronously
      setUser(devGetSession());
      setLoading(false);
    }
  }, []);

  // ── actions ────────────────────────────────────────────────────────────

  const signIn = useCallback(async (email: string, password: string) => {
    if (isFirebaseConfigured && firebaseAuth) {
      await signInWithEmailAndPassword(firebaseAuth, email, password);
      // onAuthStateChanged updates `user`
    } else {
      const u = await devSignIn(email, password);
      setUser(u);
    }
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    if (isFirebaseConfigured && firebaseAuth) {
      await createUserWithEmailAndPassword(firebaseAuth, email, password);
    } else {
      const u = await devSignUp(email, password);
      setUser(u);
    }
  }, []);

  const signOut = useCallback(async () => {
    if (isFirebaseConfigured && firebaseAuth) {
      await fbSignOut(firebaseAuth);
    } else {
      await devSignOut();
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
