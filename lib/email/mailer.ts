import { Resend } from "resend";
import type { SupabaseClient } from "@supabase/supabase-js";

export type Recipient = { name: string; email: string };

function resendClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

export function fromEmail() {
  return process.env.NOTIFICATION_FROM_EMAIL || "Aayat Profitability Portal <hello@aayat.co>";
}

export function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

/**
 * Resolve all client recipients for an account.
 * Reads BOTH the legacy `accounts.assigned_client_id` and the new
 * `account_client_members` join table, then de-duplicates by user id.
 */
export async function getClientRecipientsForAccount(
  supabase: SupabaseClient,
  accountId: string
): Promise<Recipient[]> {
  const { data: account } = await supabase
    .from("accounts")
    .select("assigned_client_id")
    .eq("id", accountId)
    .maybeSingle();

  const { data: links } = await supabase
    .from("account_client_members")
    .select("client_id")
    .eq("account_id", accountId);

  const ids = new Set<string>();
  if (account?.assigned_client_id) ids.add(String(account.assigned_client_id));
  for (const row of (links || []) as Array<{ client_id?: string }>) {
    if (row.client_id) ids.add(String(row.client_id));
  }

  if (ids.size === 0) return [];

  const { data: users } = await supabase
    .from("users")
    .select("id, full_name, email")
    .in("id", Array.from(ids));

  return ((users || []) as Array<{ id: string; full_name: string; email: string }>)
    .filter((u) => typeof u.email === "string" && u.email.includes("@"))
    .map((u) => ({ name: u.full_name || u.email, email: u.email }));
}

export type EmailWithAttachmentInput = {
  recipients: Recipient[];
  subject: string;
  /** Plain-text introductory paragraph (no HTML). */
  intro: string;
  /** Friendly account name shown in the email header. */
  accountName: string;
  /** Period or date-range label shown below the title. e.g. "Mar 2026" or "Week 11/05 – 17/05/2026". */
  periodLabel?: string;
  /** Optional bullet points (e.g. headline KPIs). Each item plain text. */
  highlights?: string[];
  /** Filename for the attached PDF, e.g. "monthly-report-aayat.pdf". */
  pdfFilename: string;
  /** Raw PDF bytes. */
  pdfBuffer: Uint8Array;
  /** Optional plain-text fallback. If not supplied, derived from `intro`. */
  textOverride?: string;
};

export type SendResult = {
  sent: boolean;
  recipients: string[];
  skipped?: string;
  messageId?: string;
};

/**
 * Send a professional HTML email with a single PDF attachment to all given recipients.
 * Returns `{ sent: false, skipped: "..." }` when RESEND_API_KEY is missing or no recipients.
 */
export async function sendPdfEmail(input: EmailWithAttachmentInput): Promise<SendResult> {
  const client = resendClient();
  if (!client) {
    return { sent: false, recipients: [], skipped: "RESEND_API_KEY not configured" };
  }
  const to = Array.from(new Set(input.recipients.map((r) => r.email).filter((e) => e && e.includes("@"))));
  if (to.length === 0) {
    return { sent: false, recipients: [], skipped: "No client recipients with valid email" };
  }

  const html = renderEmailHtml({
    title: input.subject,
    accountName: input.accountName,
    periodLabel: input.periodLabel,
    intro: input.intro,
    highlights: input.highlights || [],
  });
  const text =
    input.textOverride ||
    [
      `${input.accountName}${input.periodLabel ? ` — ${input.periodLabel}` : ""}`,
      "",
      input.intro,
      ...(input.highlights && input.highlights.length
        ? ["", "Highlights:", ...input.highlights.map((h) => `  • ${h}`)]
        : []),
      "",
      "The PDF report is attached.",
      "",
      "— Aayat Profitability Portal",
      "hello@aayat.co  |  +44 7727 666043",
    ].join("\n");

  const result = await client.emails.send({
    from: fromEmail(),
    to,
    subject: input.subject,
    text,
    html,
    attachments: [
      {
        filename: input.pdfFilename,
        // Resend accepts Buffer or base64 string for `content`.
        content: Buffer.from(input.pdfBuffer),
      },
    ],
  });

  const id =
    (result as { data?: { id?: string } | null } | undefined)?.data?.id ||
    (result as { id?: string } | undefined)?.id;
  return { sent: true, recipients: to, messageId: id };
}

function renderEmailHtml(args: {
  title: string;
  accountName: string;
  periodLabel?: string;
  intro: string;
  highlights: string[];
}) {
  const safeIntro = escapeHtml(args.intro).replace(/\n/g, "<br/>");
  const highlightsHtml = args.highlights.length
    ? `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 4px 0;width:100%;">
      <tr><td style="padding:0 0 6px 0;font-size:13px;font-weight:600;color:#401634;">Highlights</td></tr>
      ${args.highlights
        .map(
          (h) => `
        <tr><td style="padding:4px 0;font-size:14px;color:#1f2937;line-height:1.45;">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#e6126e;margin-right:8px;vertical-align:middle;"></span>
          ${escapeHtml(h)}
        </td></tr>`
        )
        .join("")}
    </table>`
    : "";

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f7eef4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f7eef4;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:620px;background:#ffffff;border:1px solid #ecd6e4;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="background:linear-gradient(135deg,#401634,#6f2a57);padding:22px 24px;color:#ffffff;">
                <p style="margin:0;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.85;">Aayat Profitability Portal</p>
                <h1 style="margin:6px 0 0 0;font-size:20px;font-weight:600;line-height:1.3;">${escapeHtml(args.title)}</h1>
                <p style="margin:6px 0 0 0;font-size:14px;opacity:0.9;">
                  ${escapeHtml(args.accountName)}${args.periodLabel ? ` &nbsp;•&nbsp; ${escapeHtml(args.periodLabel)}` : ""}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 24px 8px 24px;font-size:15px;line-height:1.55;color:#1f2937;">
                <p style="margin:0 0 12px 0;">Hello,</p>
                <p style="margin:0 0 12px 0;">${safeIntro}</p>
                ${highlightsHtml}
                <p style="margin:16px 0 0 0;">The full PDF is attached to this email. If you have any questions, just reply to this message and the Aayat team will get back to you.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 24px 22px 24px;color:#1f2937;">
                <p style="margin:18px 0 4px 0;font-size:14px;">Best regards,</p>
                <p style="margin:0;font-size:14px;font-weight:600;">The Aayat Team</p>
              </td>
            </tr>
            <tr>
              <td style="background:#f7eef4;padding:14px 24px;border-top:1px solid #ecd6e4;color:#6b7280;font-size:12px;line-height:1.5;">
                Aayat &nbsp;•&nbsp; <a href="mailto:hello@aayat.co" style="color:#6f2a57;text-decoration:none;">hello@aayat.co</a> &nbsp;•&nbsp; +44 7727 666043
                <br/><span style="color:#9ca3af;">This message and the attached report are intended for the registered account contact.</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(input: string) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
