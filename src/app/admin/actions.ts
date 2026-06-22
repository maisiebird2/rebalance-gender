"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";

async function requireAuth() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin");
}

// ── Submission moderation ──────────────────────────────────────────

export async function quickApprove(id: string): Promise<{ error: string } | void> {
  await requireAuth();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("artists")
    .update({ directory_status: "approved" })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin");
  revalidatePath("/");
}

export async function quickReject(id: string): Promise<{ error: string } | void> {
  await requireAuth();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("artists")
    .update({ directory_status: "rejected" })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin");
}

// ── Genres ──────────────────────────────────────────────────────────

export async function addGenre(
  formData: FormData
): Promise<{ error: string } | { success: true }> {
  await requireAuth();

  const name = ((formData.get("name") ?? "") as string).trim();
  if (!name) return { error: "Genre name is required" };

  const admin = getSupabaseAdminClient();

  const { data: existing } = await admin
    .from("genres")
    .select("id")
    .eq("name", name)
    .maybeSingle();
  if (existing) return { error: `"${name}" already exists` };

  const { error } = await admin.from("genres").insert({ name });
  if (error) return { error: error.message };

  revalidatePath("/admin");
  revalidatePath("/submit");
  revalidatePath("/");
  return { success: true };
}

// ── Profile link categories (platforms) ──────────────────────────────

// Derives a stable lookup key from a display label, e.g.
// "Mixcloud" -> "mixcloud", "NTS Radio" -> "nts_radio".
function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function addPlatform(
  formData: FormData
): Promise<{ error: string } | { success: true }> {
  await requireAuth();

  const label = ((formData.get("label") ?? "") as string).trim();
  if (!label) return { error: "Category name is required" };

  const key = slugify(label);
  if (!key) return { error: "Couldn't derive a key from that name — try adding a letter or number" };

  const admin = getSupabaseAdminClient();

  const { data: existing } = await admin
    .from("platforms")
    .select("key")
    .eq("key", key)
    .maybeSingle();
  if (existing) return { error: `"${label}" already exists` };

  const { data: maxRow } = await admin
    .from("platforms")
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sortOrder = (maxRow?.sort_order ?? 0) + 10;

  const { error } = await admin
    .from("platforms")
    .insert({ key, label, sort_order: sortOrder });
  if (error) return { error: error.message };

  revalidatePath("/admin");
  revalidatePath("/submit");
  return { success: true };
}
