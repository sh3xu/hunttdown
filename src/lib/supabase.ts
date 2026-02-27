import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Since we are using the public ANON key,
// you MUST DISABLE RLS (Row Level Security) in your Supabase dashboard
// for the projects, nodes, and edges tables to allow inserts.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
