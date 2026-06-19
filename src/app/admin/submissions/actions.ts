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
  if (!user) redirect("/login?next=/admin/submissions");
}

export async function quickApprove(id: string): Promise<{ error: string } | void> {
  await requireAuth();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("artists")
    .update({ status: "approved" })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin/submissions");
  revalidatePath("/");
}

export async function quickReject(id: string): Promise<{ error: string } | void> {
  await requireAuth();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("artists")
    .update({ status: "rejected" })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin/submissions");
}
