import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/types/auth";

export async function requireAuth() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return { supabase, user };
}

export async function requireRole(allowedRoles: UserRole[]) {
  const { supabase, user } = await requireAuth();

  const { data, error } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  if (error || !data?.role || !allowedRoles.includes(data.role as UserRole)) {
    redirect("/forbidden");
  }

  return { supabase, user, role: data.role as UserRole };
}
