import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Amazon Connection — Aayat",
  robots: { index: false, follow: false },
};

/**
 * Public landing page shown to a seller after they complete (or decline) the
 * Amazon SP-API consent flow. Deliberately NOT gated by portal auth — the
 * seller does not have an Aayat login.
 */
export default function AmazonConnectedPage({
  searchParams,
}: {
  searchParams: { status?: string; message?: string; account?: string };
}) {
  const status = searchParams.status === "ok" ? "ok" : "error";
  const message = (searchParams.message || "").trim();
  const accountName = (searchParams.account || "").trim();

  const heading =
    status === "ok" ? "Amazon connected successfully" : "Amazon connection failed";

  const subheading =
    status === "ok"
      ? "You can close this tab. Aayat will start pulling sales, fees, and inventory data automatically."
      : "Please contact your Aayat account manager and share the message below.";

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <Image
          src="/aayat-logo.png"
          alt="Aayat"
          width={2400}
          height={472}
          className="mb-6 h-auto w-32"
          priority
        />
        <div
          className={`mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full ${
            status === "ok" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
          }`}
        >
          <span className="text-2xl font-bold">{status === "ok" ? "✓" : "⚠"}</span>
        </div>
        <h1 className="text-2xl font-semibold text-slate-900">{heading}</h1>
        {accountName ? (
          <p className="mt-1 text-sm text-slate-500">
            Account: <span className="font-medium text-slate-700">{accountName}</span>
          </p>
        ) : null}
        <p className="mt-3 text-sm text-slate-700">{subheading}</p>

        {message ? (
          <div
            className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
              status === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border-red-200 bg-red-50 text-red-900"
            }`}
          >
            {message}
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-2">
          <Link
            href="/settings"
            className="rounded-lg bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-white"
          >
            Open portal settings
          </Link>
          <Link
            href="https://aayat.co"
            className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700"
          >
            Back to Aayat
          </Link>
        </div>

        <p className="mt-6 text-xs text-slate-400">
          Aayat does not see or store your Amazon password. Authorization is handled by Amazon and you
          can revoke access anytime from Seller Central → Partner Network → Manage Your Apps.
        </p>
      </div>
    </div>
  );
}
