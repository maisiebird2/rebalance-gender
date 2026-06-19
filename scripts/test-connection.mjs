#!/usr/bin/env node
// Quick diagnostic: checks .env.local values and tries a raw fetch +
// a supabase-js call against the artists table, printing everything.
//
// Run with: node scripts/test-connection.mjs

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
const SECRET = process.env.SUPABASE_SECRET_KEY;

console.log("--- env values ---");
console.log("URL:", JSON.stringify(URL), `(length ${URL?.length})`);
console.log(
  "SECRET starts with:",
  SECRET?.slice(0, 14),
  "... length",
  SECRET?.length
);

console.log("\n--- raw fetch test ---");
try {
  const res = await fetch(`${URL}/rest/v1/artists?select=id&limit=1`, {
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
    },
  });
  const text = await res.text();
  console.log("status:", res.status, res.statusText);
  console.log("body:", text);
} catch (e) {
  console.log("raw fetch threw:", e);
}

console.log("\n--- supabase-js test ---");
const supabase = createClient(URL, SECRET, { auth: { persistSession: false } });
const result = await supabase.from("artists").select("id", { count: "exact", head: true });
console.log("result:", result);
