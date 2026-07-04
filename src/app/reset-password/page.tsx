"use client";

// Set-a-new-password page for the Supabase password-recovery flow.
//
// A recovery email link lands the user here with a temporary "recovery"
// session. This page confirms that session, shows a new-password form, and
// calls supabase.auth.updateUser({ password }) to set it.
//
// It tolerates the two ways Supabase can deliver the recovery session:
//   1. token_hash in the query string (recommended email-template flow) —
//      we exchange it with verifyOtp().
//   2. a PKCE `code` / hash tokens that @supabase/ssr exchanges automatically
//      on load, firing a PASSWORD_RECOVERY / SIGNED_IN auth event.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";

type Status = "verifying" | "ready" | "invalid";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("verifying");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let active = true;

    // Catch the recovery session however it arrives.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session)) {
        setStatus("ready");
      }
    });

    async function init() {
      // Email-template flow: token_hash in the URL.
      const params = new URLSearchParams(window.location.search);
      const tokenHash = params.get("token_hash");
      const type = params.get("type");

      if (tokenHash && type === "recovery") {
        const { error } = await supabase.auth.verifyOtp({
          type: "recovery",
          token_hash: tokenHash,
        });
        if (!active) return;
        setStatus(error ? "invalid" : "ready");
        return;
      }

      // Otherwise a session may already exist (code exchanged on load).
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      if (data.session) {
        setStatus("ready");
      } else {
        // Give the auth listener a moment before declaring the link invalid.
        setTimeout(() => {
          if (active) {
            setStatus((s) => (s === "verifying" ? "invalid" : s));
          }
        }, 2500);
      }
    }

    init();

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don’t match.");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }

    // Drop the temporary recovery session so the user signs in fresh.
    await supabase.auth.signOut();
    setDone(true);
    setLoading(false);
    setTimeout(() => router.push("/login"), 2000);
  }

  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <h1 className="mb-6 text-xl font-bold">Set a new password</h1>

      {status === "verifying" && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Verifying your reset link…
        </p>
      )}

      {status === "invalid" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-red-600 dark:text-red-400">
            This reset link is invalid or has expired. Request a new one and try
            again.
          </p>
          <a
            href="/login"
            className="text-sm font-medium text-violet-600 hover:underline"
          >
            Back to sign in
          </a>
        </div>
      )}

      {status === "ready" && !done && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="password" className="text-sm font-medium">
              New password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="confirm" className="text-sm font-medium">
              Confirm new password
            </label>
            <input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
              className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
          >
            {loading ? "Updating…" : "Update password"}
          </button>
        </form>
      )}

      {done && (
        <p className="text-sm text-green-600 dark:text-green-400">
          Password updated. Redirecting you to sign in…
        </p>
      )}
    </div>
  );
}
