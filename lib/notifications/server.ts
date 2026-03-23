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
  linkPath?: string;
}) {
  if (!payload.to) return;
  const client = resendClient();
  if (!client) return;

  const baseUrl =
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  const fullLink =
    payload.linkPath && baseUrl
      ? `${baseUrl.replace(/\/+$/, "")}/${payload.linkPath.replace(/^\/+/, "")}`
      : undefined;
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;margin:0 auto;background:#fff7fb;border:1px solid #f3d9e8;border-radius:12px;overflow:hidden;">
    <div style="background:#3a0f45;padding:16px 20px;color:#ffffff;">
      <h2 style="margin:0;font-size:18px;">Aayat Profitability Portal</h2>
    </div>
    <div style="padding:20px;color:#1f2937;">
      <p style="margin-top:0;">Hello,</p>
      <p>${payload.text.replace(/\n/g, "<br/>")}</p>
      ${
        fullLink
          ? `<p style="margin-top:20px;"><a href="${fullLink}" style="display:inline-block;background:#e11672;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:600;">Open Portal</a></p>`
          : ""
      }
      <p style="margin:20px 0 0 0;">Thanks,<br/>Aayat Team</p>
    </div>
    <div style="padding:12px 20px;border-top:1px solid #f3d9e8;color:#6b7280;font-size:12px;">
      © aayat.co | hello@aayat.co | +44 7727 666043
    </div>
  </div>`;

  await client.emails.send({
    from: fromEmail(),
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html,
  });
}
