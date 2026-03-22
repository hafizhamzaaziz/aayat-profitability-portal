"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        setError(signInError.message);
        return;
      }

      router.replace(nextPath);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-[var(--md-primary)]"
          placeholder="you@company.com"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-[var(--md-primary)]"
          placeholder="Enter your password"
        />
      </div>

      {error ? (
        <div className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-2xl bg-[var(--md-primary)] px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Signing in..." : "Sign in"}
      </button>

      <p className="text-center text-xs text-slate-500">Account creation is admin-only. No public signup.</p>
    </form>
  );
}
