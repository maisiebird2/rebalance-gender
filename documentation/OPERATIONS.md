# Operations & backend setup

Operational and backend configuration for the site — the setup that lives in
external dashboards (Supabase, Resend, Vercel, DNS) rather than in code. Add
new backend/ops runbooks here as they come up; auth is the first.

---

# Authentication & auth email setup

How login, sign-out, and password recovery work for the admin/edit side of
the site, plus the Supabase dashboard config they depend on. Public visitors
don't log in — auth only gates the moderation queue, artist edit, and
missing-links pages.

---

## Auth model

- **Provider:** Supabase Auth (email + password). There is **no public
  sign-up** — the app has no registration flow. Users are provisioned by
  hand in the Supabase dashboard under **Authentication → Users**.
- The app login at `https://www.rebalance-gender.app/login` authenticates
  against a *user row in this project's Auth system*. That is **separate**
  from your Supabase **account** login at supabase.com (the dashboard). They
  are independent accounts that may happen to share a password — changing one
  does not change the other. Keep them different, and prefer 2FA on the
  Supabase account itself.
- Sessions are cookie-based via `@supabase/ssr`. Client helper:
  `src/lib/supabase/browser.ts` (`createClient()`); server helper:
  `src/lib/supabase/server.ts`.

### Key files

```
src/app/login/page.tsx           # Sign-in form + "Forgot password?" trigger
src/app/reset-password/page.tsx  # Set-a-new-password page (recovery flow)
src/app/auth-actions.ts          # signOut() server action
src/app/api/auth/callback/route.ts  # OAuth/code exchange (exchangeCodeForSession)
```

---

## Changing / resetting a password

Two ways:

1. **Directly in the dashboard (fastest for admins):**
   Supabase → **Authentication → Users** → pick the user → reset/set
   password. Or provision a brand-new user with **Add user**.

2. **Via the app's recovery flow (self-service):**
   On `/login`, enter your email and click **Forgot password?**. This calls
   `supabase.auth.resetPasswordForEmail(email, { redirectTo:
   <origin>/reset-password })`, which emails a recovery link. The link lands
   on `/reset-password`, which confirms the recovery session and calls
   `supabase.auth.updateUser({ password })`, then signs you out and returns
   you to `/login`.

The `/reset-password` page tolerates both delivery styles: a `token_hash`
query param (verified with `verifyOtp`) or a PKCE `code`/hash that
`@supabase/ssr` exchanges automatically on load.

---

## Required Supabase dashboard config

These make the recovery flow actually reach the app. All under
**Authentication**:

### URL Configuration

| Setting | Value |
|---|---|
| **Site URL** | `https://www.rebalance-gender.app` (NOT `localhost:3000`) |
| **Redirect URLs** | add `https://www.rebalance-gender.app/reset-password` (keep `http://localhost:3000/**` for local dev) |

If Site URL is left on `localhost:3000`, recovery links redirect to your
local machine and appear to "do nothing."

### Reset Password email template

Point the link at the app page with a token hash. **Authentication → Emails**
(may appear as **Templates**), select **Reset Password**, and set the link to:

```html
<a href="{{ .SiteURL }}/reset-password?token_hash={{ .TokenHash }}&type=recovery">Reset password</a>
```

Leave the `{{ .SiteURL }}` / `{{ .TokenHash }}` template variables exactly as
written (double-brace syntax).

---

## Auth email sending (custom SMTP via Resend)

Supabase's built-in auth email sender is **rate-limited to a couple of
messages per hour** and is for testing only. Symptom of hitting it:
`email rate limit exceeded` when requesting a reset. Fix: route auth emails
through Resend, which this project already uses for transactional email
(`src/lib/email.ts`).

Resend exposes SMTP using the **same API key** as the SDK. Enable **Custom
SMTP** under **Authentication → Emails → SMTP Settings** and enter:

| Field | Value |
|---|---|
| Sender email | `noreply@rebalance-gender.app` (`RESEND_FROM_ADDRESS`; a verified Resend domain) |
| Sender name | e.g. `Rebalance Gender` |
| Host | `smtp.resend.com` |
| Port | `465` (or `587` if 465 is blocked) |
| Username | `resend` (literally — not an email address) |
| Password | the `RESEND_API_KEY` value from `.env.local` |

Once custom SMTP is on, the built-in rate limit no longer applies and auth
emails send from the verified domain. After enabling, allow a few minutes for
any existing built-in-sender cooldown to clear before testing.

---

## Related env vars

See CONTEXT.md for the full table. Auth email specifically uses:

| Variable | Notes |
|---|---|
| `RESEND_API_KEY` | Resend API key; doubles as the SMTP password. Server-only, never committed. |
| `RESEND_FROM_ADDRESS` | Verified sender, e.g. `noreply@rebalance-gender.app`. Also the SMTP sender email. |
