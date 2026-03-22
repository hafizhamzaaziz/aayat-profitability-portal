import { Suspense } from "react";
import AppShell from "@/components/layout/app-shell";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-600">Loading workspace...</div>}>
      <AppShell>{children}</AppShell>
    </Suspense>
  );
}
