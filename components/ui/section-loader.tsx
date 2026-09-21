export default function SectionLoader({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4" role="status" aria-live="polite">
      <p className="text-sm font-medium text-slate-600">{label}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-2xl bg-slate-100" />
        ))}
      </div>
      <div className="h-40 animate-pulse rounded-2xl bg-slate-100" />
    </div>
  );
}
