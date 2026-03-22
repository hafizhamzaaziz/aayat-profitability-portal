import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import LoginForm from "./login-form";

export const metadata: Metadata = {
  title: "Login",
};

export default async function LoginPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--md-surface)] p-4">
      <div className="w-full max-w-md rounded-3xl border border-[var(--md-outline)] bg-[var(--md-surface-container)] p-8 shadow-sm">
        <p className="md-chip mb-3">Aayat Profitability Portal</p>
        <h1 className="mb-2 text-2xl font-semibold text-slate-900">Sign in</h1>
        <p className="mb-6 text-sm text-slate-600">Use your assigned email and password to continue.</p>
        <LoginForm />
      </div>
    </div>
  );
}
