import { Resend } from "resend";
import type { SupabaseClient } from "@supabase/supabase-js";

type NotificationLevel = "info" | "warning" | "error" | "success";

type NotificationPayload = {
  userId: string;
  title: string;
  body: string;
  level?: NotificationLevel;
  link?: string;
  eventKey?: string;
  email?: string | null;
};

function resendClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

function fromEmail() {
  return process.env.NOTIFICATION_FROM_EMAIL || "hello@aayat.co";
}

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

export async function sendNotificationEmailIfConfigured(payload: {
  to?: string | null;
  subject: string;
  text: string;
}) {
  if (!payload.to) return;
  const client = resendClient();
  if (!client) return;

  await client.emails.send({
    from: fromEmail(),
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
  });
}
