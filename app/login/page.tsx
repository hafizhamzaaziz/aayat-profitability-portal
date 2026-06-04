import type { Metadata } from "next";
import Image from "next/image";
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
        <Image
          src="/aayat-logo.png"
          alt="Aayat"
          width={2400}
          height={472}
          className="mb-5 h-auto w-36"
          priority
        />
        <p className="md-chip mb-3">Profitability Portal</p>
        <h1 className="mb-2 text-2xl font-semibold text-[var(--md-secondary)]">Sign in</h1>
        <p className="mb-6 text-sm text-slate-600">Use your assigned email and password to continue.</p>
        <LoginForm />
      </div>
    </div>
  );
}
