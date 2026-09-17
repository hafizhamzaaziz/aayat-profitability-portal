/**
 * PostgREST caps every response at the project's "Max rows" setting (1000 by
 * default) regardless of the requested `.range()`. Page through the full
 * result so aggregates and tables are not silently truncated.
 * `pageSize` must stay <= the server cap.
 */
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
