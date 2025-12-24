import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || "";

// Check if Supabase is properly configured
const isConfigured = !!(
  supabaseUrl &&
  supabaseServiceKey &&
  supabaseUrl !== "https://your-project.supabase.co"
);

if (!isConfigured) {
  console.warn(
    "Supabase credentials not configured. Storage uploads will fall back to local storage."
  );
}

// Only create client if properly configured
export const supabase: SupabaseClient | null = isConfigured
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

export const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "images";

export const isSupabaseConfigured = () => {
  return isConfigured;
};

export default supabase;
