import type { SupabaseClient } from "@supabase/supabase-js";

type NotificationLevel = "info" | "warning" | "error" | "success";

type NotificationPayload = {
  userId: string;
  title: string;
  body: string;
  level?: NotificationLevel;
  link?: string;
  eventKey?: string;
};

export async function createNotification(
  supabase: SupabaseClient,
  payload: NotificationPayload
): Promise<{ inserted: boolean; id?: string }> {
  const existing = payload.eventKey
    ? await supabase.from("notifications").select("id").eq("event_key", payload.eventKey).maybeSingle()
    : { data: null as { id?: string } | null };

  if (existing.data?.id) {
    return { inserted: false, id: existing.data.id };
  }

  const { data, error } = await supabase
    .from("notifications")
    .insert({
      user_id: payload.userId,
      title: payload.title,
      body: payload.body,
      level: payload.level || "info",
      link: payload.link || null,
      event_key: payload.eventKey || null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return { inserted: true, id: data?.id };
}
