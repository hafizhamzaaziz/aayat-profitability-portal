import { createClient } from "@/lib/supabase/client";

type Level = "info" | "warning" | "error" | "success";

export async function pushClientNotification(input: {
  title: string;
  body: string;
  level?: Level;
  link?: string;
  eventKey?: string;
}) {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    if (input.eventKey) {
      const { data: existing } = await supabase.from("notifications").select("id").eq("event_key", input.eventKey).maybeSingle();
      if (existing?.id) return;
    }

    await supabase.from("notifications").insert({
      user_id: user.id,
      title: input.title,
      body: input.body,
      level: input.level || "info",
      link: input.link || null,
      event_key: input.eventKey || null,
    });
  } catch {
    // best effort; do not block user workflow
  }
}
