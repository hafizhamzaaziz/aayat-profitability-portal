export default function PortalLoading() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-48 animate-pulse rounded-xl bg-slate-200" />
      <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
        <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
        <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
      </div>
    </div>
  );
}
