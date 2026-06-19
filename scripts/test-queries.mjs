#!/usr/bin/env node
// Diagnostic: runs the genre/country filter queries using the
// PUBLISHABLE key (same as the app does), and prints raw results +
// errors so we can see exactly what's going wrong.
//
// Run with: node scripts/test-queries.mjs

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const supabase = createClient(URL, PUB, { auth: { persistSession: false } });

console.log("--- raw counts (publishable key) ---");
for (const table of ["artists", "genres", "artist_genres", "artist_locations"]) {
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
  console.log(table, "count:", count, "error:", error?.message ?? null);
}

console.log("\n--- approved artists count ---");
{
  const { count, error } = await supabase
    .from("artists")
    .select("*", { count: "exact", head: true })
    .eq("status", "approved");
  console.log("approved artists:", count, "error:", error?.message ?? null);
}

console.log("\n--- getGenreOptions query ---");
{
  const { data, error } = await supabase
    .from("artist_genres")
    .select("genres!inner(name), artists!inner(status)")
    .eq("artists.status", "approved")
    .limit(5);
  console.log("error:", error);
  console.log("sample data:", JSON.stringify(data, null, 2));
}

console.log("\n--- getCountryOptions query ---");
{
  const { data, error } = await supabase
    .from("artist_locations")
    .select("country, artists!inner(status)")
    .eq("artists.status", "approved")
    .not("country", "is", null)
    .limit(5);
  console.log("error:", error);
  console.log("sample data:", JSON.stringify(data, null, 2));
}
