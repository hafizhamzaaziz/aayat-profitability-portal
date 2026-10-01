# AGENTS.md

## Cursor Cloud specific instructions

### Product overview
Aayat Profitability Portal — a multi-tenant Next.js 14 profitability dashboard for Amazon/Temu seller accounts. Uses Supabase (auth, DB, storage) as sole backend dependency.

### Required environment variables
These are injected as Cursor Cloud secrets and must also be in `.env.local`:
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL (format: `https://<ref>.supabase.co`; the ref can be extracted from the anon key JWT payload field `ref`)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon/public key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key (admin API routes, user creation)

Optional:
- `RESEND_API_KEY` — for email notifications (gracefully skipped if absent)
- `NOTIFICATION_FROM_EMAIL` — sender address for notification emails

### Creating a test user for manual testing
Public signup is disabled. To create a test admin user for login, use the service role key:
```js
const { createClient } = require('@supabase/supabase-js');
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: 'Test' } });
await admin.from('users').insert({ id: authUser.user.id, role: 'admin', full_name: 'Test', email });
```
Remember to clean up test users after testing.

### Running the dev server
```
npm run dev          # starts on http://localhost:3000
npm run dev:clean    # removes .next cache first, then starts dev server
```

### Lint / Build / Test
- `npm run lint` — runs ESLint (flat config)
- `npm run build` — production build (also validates types)
- No automated test suite exists in this repository

### Key architecture notes
- All backend logic lives in Next.js API routes (`app/api/`) and Server Components.
- Supabase client helpers are in `lib/supabase/` (browser, server, middleware, admin).
- Middleware (`middleware.ts`) enforces auth + role-based access on all routes except `/login` and `/forbidden`.
- The schema is defined in `supabase/schema.sql`; apply it in the Supabase SQL editor for new projects.
- No Docker, Redis, or external queue workers are used.

### Gotchas
- The dev server uses `WATCHPACK_POLLING=true` for file watching (set in the `dev` npm script). This is important for environments with non-native file systems.
- Without valid Supabase credentials the app compiles and renders the login page, but Supabase API calls will fail with network errors.
- Node.js 20.x is required (installed via nodesource in Cloud Agent VMs). The environment does not ship with Node pre-installed.
