import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | Aayat Consulting Ltd",
  description:
    "How Aayat Consulting Ltd collects, uses, stores and protects personal data.",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-[var(--md-surface)] px-4 py-12">
      <article className="mx-auto max-w-3xl rounded-3xl border border-[var(--md-outline)] bg-[var(--md-surface-container)] p-8 shadow-sm sm:p-12">
        <h1 className="text-3xl font-semibold text-[var(--md-secondary)]">Privacy Policy</h1>
        <div className="mt-2 text-sm text-slate-600">
          <p>AAYAT CONSULTING LTD (Company No. 17061494)</p>
          <p>Registered address: 130 Holborn Street, Rochdale, United Kingdom, OL11 4QE</p>
          <p>Contact: hello@aayat.co</p>
          <p>Last updated: 8 June 2026</p>
        </div>

        <div className="mt-8 space-y-8 text-sm leading-relaxed text-slate-700">
          <section>
            <h2 className="mb-2 text-lg font-semibold text-[var(--md-secondary)]">1. Introduction</h2>
            <p>
              This Privacy Policy explains how Aayat Consulting Ltd (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;)
              collects, uses, stores and protects personal data in connection with the operation of our e-commerce shops
              and our internal profitability-reporting tool, the Aayat Profitability Portal (&ldquo;the Portal&rdquo;). We
              are committed to protecting personal data and handling it in accordance with the UK GDPR and the Data
              Protection Act 2018.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-[var(--md-secondary)]">2. Scope</h2>
            <p>
              This policy applies to personal data we process when we operate and manage e-commerce shops on platforms
              including TikTok Shop, Amazon and Temu, and when we use the Portal to analyse the performance and
              profitability of those shops.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-[var(--md-secondary)]">3. What data we process and where it comes from</h2>
            <p>
              When a shop we operate is connected to the Portal, we access &mdash; on a read-only basis &mdash; order,
              settlement/finance and return information from the platform&rsquo;s APIs. This may include order details
              (order ID, status, items/SKUs, quantities, order amounts, returns), settlement and fee information, and
              where present in order data, limited personal data such as customer name and delivery/contact details. We
              obtain this data directly from the relevant platform via authorised API access granted by the shop owner.
              We do not create, modify or delete any data in the connected shop.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-[var(--md-secondary)]">4. Purposes and legal bases</h2>
            <ul className="ml-5 list-disc space-y-1">
              <li>Calculating profit &amp; loss and analysing the performance of shops we operate &mdash; legitimate interests.</li>
              <li>Meeting accounting, tax and record-keeping obligations &mdash; legal obligation.</li>
              <li>Securing our systems and preventing fraud &mdash; legitimate interests.</li>
            </ul>
            <p className="mt-2">We process personal data only to the extent necessary for these purposes.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-[var(--md-secondary)]">5. Data sharing and sub-processors</h2>
            <p>
              We do not sell personal data and do not share it for marketing. We use the following service providers
              (sub-processors), each bound by data-processing terms: Vercel (application hosting), Supabase (database,
              authentication and storage, hosted in the EU &mdash; Ireland), and Resend (transactional email). We may
              disclose data where required by law or to protect our legal rights.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-[var(--md-secondary)]">6. International transfers</h2>
            <p>
              Our database and stored data are hosted within the European Union (Ireland). Where any data is processed
              outside the UK/EEA by a sub-processor, we rely on appropriate safeguards such as adequacy decisions or
              Standard Contractual Clauses.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-[var(--md-secondary)]">7. Data retention</h2>
            <p>
              We retain data only for as long as necessary for the purposes above and to meet legal/accounting
              obligations. When a shop is disconnected, stored access credentials are deleted. At the end of a
              contractual relationship, we delete the collected customer data in our possession (subject to any legal
              retention requirements).
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-[var(--md-secondary)]">8. How we protect data</h2>
            <p>
              We apply technical and organisational measures including: TLS/HTTPS encryption in transit; AES-256-GCM
              encryption of access tokens at rest; database encryption at rest; role-based access control and database
              row-level security; least-privilege access; multi-factor authentication on administrative accounts; and
              managed, isolated cloud infrastructure.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-[var(--md-secondary)]">9. Your rights</h2>
            <p>
              Subject to UK GDPR, individuals have the right to access, rectify, erase, restrict, or object to processing
              of their personal data, and to data portability. To exercise these rights, contact us at hello@aayat.co.
              You also have the right to complain to the Information Commissioner&rsquo;s Office (ICO) at ico.org.uk.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-[var(--md-secondary)]">10. Cookies</h2>
            <p>
              The Portal is an internal tool that uses only essential cookies required for authentication and session
              management. It is not a public marketing website.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-[var(--md-secondary)]">11. Changes to this policy</h2>
            <p>We may update this policy from time to time. The &ldquo;Last updated&rdquo; date above reflects the latest version.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-[var(--md-secondary)]">12. Contact</h2>
            <p>
              For any privacy questions or requests, contact hello@aayat.co or write to us at 130 Holborn Street,
              Rochdale, United Kingdom, OL11 4QE.
            </p>
          </section>
        </div>
      </article>
    </div>
  );
}
