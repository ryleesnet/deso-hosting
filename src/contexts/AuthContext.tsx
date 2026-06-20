"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
} from "react";
import { useRouter } from "next/navigation";
import {
  initDeSo,
  loginWithDeSo,
  logoutDeSo,
  getCurrentUser,
  getRememberedSessionDesoUsername,
  rememberSessionDesoUsername,
  fetchClientDesoUsername,
} from "@/lib/deso";
import { clearJwtCache, setApiSessionPublicKey, apiFetch } from "@/lib/api-client";

interface AuthContextType {
  user: { publicKey: string; username?: string } | null;
  loading: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<{
    publicKey: string;
    username?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  /** Runs before child `useEffect` so `apiFetch` sees the correct pubkey on first load after login. */
  useLayoutEffect(() => {
    setApiSessionPublicKey(user?.publicKey ?? null);
  }, [user?.publicKey]);

  useEffect(() => {
    initDeSo();
    const u = getCurrentUser();
    const remembered = getRememberedSessionDesoUsername();
    setApiSessionPublicKey(u?.publicKey ?? null);
    setUser(u ? { ...u, username: remembered } : null);
    setLoading(false);

    if (!u?.publicKey || remembered?.trim()) return undefined;

    let cancelled = false;
    void (async () => {
      try {
        const username = await fetchClientDesoUsername(u.publicKey);
        if (
          cancelled ||
          typeof username !== "string" ||
          !username.trim()
        )
          return;
        const trimmed = username.trim();
        rememberSessionDesoUsername(trimmed);
        setUser((prev) =>
          prev?.publicKey === u.publicKey
            ? { ...prev, username: trimmed }
            : prev
        );
      } catch {
        /* offline / transient */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user?.publicKey) {
      setIsAdmin(false);
      return undefined;
    }

    let cancelled = false;
    void apiFetch("/api/auth/verify", { method: "POST" })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          isAdmin?: boolean;
        };
        if (!res.ok) return false;
        return Boolean(data.isAdmin);
      })
      .then((admin) => {
        if (!cancelled) setIsAdmin(admin);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.publicKey]);

  const login = useCallback(async () => {
    setLoading(true);
    // New session (or new active user) means any cached JWT is stale.
    clearJwtCache();
    const result = await loginWithDeSo();
    if (result) {
      rememberSessionDesoUsername(result.username);
      setApiSessionPublicKey(result.publicKey);
      setUser({ publicKey: result.publicKey, username: result.username });
    } else {
      setApiSessionPublicKey(null);
    }
    setLoading(false);
  }, []);

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      const loggedOut = await logoutDeSo();
      if (!loggedOut) return;
      setApiSessionPublicKey(null);
      setUser(null);
      setIsAdmin(false);
      router.replace("/");
    } catch (err) {
      console.error("DeSo logout failed:", err);
    } finally {
      setLoading(false);
    }
  }, [router]);

  return (
    <AuthContext.Provider
      value={{ user, loading, login, logout, isAdmin }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
