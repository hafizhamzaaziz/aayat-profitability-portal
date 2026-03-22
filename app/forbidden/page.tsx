import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Forbidden",
};

export default function ForbiddenPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--md-surface)] p-4">
      <div className="w-full max-w-md rounded-3xl border border-[var(--md-outline)] bg-[var(--md-surface-container)] p-8 text-center shadow-sm">
        <p className="mb-2 text-4xl">🔒</p>
        <h1 className="mb-2 text-2xl font-semibold">Access restricted</h1>
        <p className="mb-6 text-sm text-slate-600">
          Your role does not have permission to access this page.
        </p>
        <Link
          href="/dashboard"
          className="inline-flex rounded-2xl bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
