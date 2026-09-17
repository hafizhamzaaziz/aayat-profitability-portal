// PostgREST caps every response at the project's "Max rows" setting (1000 by
// default) regardless of the requested `.range()`. Tables like
// `inventory_sales_facts_cache` hold tens of thousands of rows per account, so
// a single fetch silently returns an arbitrary slice and aggregates undercount.
// `pageSize` must stay <= the server cap; 1000 matches the Supabase default.

export async function fetchAllRows<T>(
  makeQuery: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = [];
  let from = 0;
  for (let guard = 0; guard < 5000; guard++) {
    const { data, error } = await makeQuery(from, from + pageSize - 1);
    if (error) return { data: all, error };
    const batch = (data || []) as T[];
    all.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return { data: all, error: null };
}
