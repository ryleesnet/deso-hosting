"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";
import {
  initDeSo,
  loginWithDeSo,
  logoutDeSo,
  getCurrentUser,
  getRememberedSessionDesoUsername,
  rememberSessionDesoUsername,
} from "@/lib/deso";
import { clearJwtCache } from "@/lib/api-client";

interface AuthContextType {
  user: { publicKey: string; username?: string } | null;
  loading: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

const ADMIN_KEYS = (process.env.NEXT_PUBLIC_ADMIN_PUBLIC_KEYS || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<{
    publicKey: string;
    username?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    initDeSo();
    const u = getCurrentUser();
    const remembered = getRememberedSessionDesoUsername();
    setUser(u ? { ...u, username: remembered } : null);
    setLoading(false);

    if (!u?.publicKey || remembered?.trim()) return undefined;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/profile/username", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicKey: u.publicKey }),
        });
        const data = (await res.json()) as { username?: string | null };
        if (
          cancelled ||
          typeof data.username !== "string" ||
          !data.username.trim()
        )
          return;
        const trimmed = data.username.trim();
        rememberSessionDesoUsername(data.username);
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

  const login = useCallback(async () => {
    setLoading(true);
    // New session (or new active user) means any cached JWT is stale.
    clearJwtCache();
    const result = await loginWithDeSo();
    if (result) {
      rememberSessionDesoUsername(result.username);
      setUser({ publicKey: result.publicKey, username: result.username });
    }
    setLoading(false);
  }, []);

  const logout = useCallback(async () => {
    setLoading(true);
    await logoutDeSo();
    setUser(null);
    setLoading(false);
  }, []);

  const isAdmin = user ? ADMIN_KEYS.includes(user.publicKey) : false;

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
