import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UserRole } from "@/lib/types/auth";

export const runtime = "nodejs";

async function requireAdmin() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false as const, status: 401, message: "Unauthorized" };
  }

  const { data: row } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (row?.role !== "admin") {
    return { ok: false as const, status: 403, message: "Forbidden" };
  }

  return { ok: true as const, userId: user.id };
}

function errorMessage(err: unknown, fallback: string) {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) {
    return new Response(auth.message, { status: auth.status });
  }

  try {
    const body = (await request.json()) as {
      email?: string;
      password?: string;
      fullName?: string;
      role?: UserRole;
    };

    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const fullName = String(body.fullName || "").trim();
    const role = body.role;

    if (!email || !password || !fullName || !role) {
      return new Response("Missing required fields.", { status: 400 });
    }

    if (!["admin", "team", "client"].includes(role)) {
      return new Response("Invalid role.", { status: 400 });
    }

    const admin = createAdminClient();

    const { data: authUser, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });

    if (createError || !authUser.user?.id) {
      throw createError || new Error("Failed to create auth user.");
    }

    const { error: profileError } = await admin.from("users").insert({
      id: authUser.user.id,
      role,
      full_name: fullName,
      email,
    });

    if (profileError) {
      await admin.auth.admin.deleteUser(authUser.user.id);
      throw profileError;
    }

    return Response.json({ id: authUser.user.id });
  } catch (err) {
    return new Response(errorMessage(err, "Failed to create user."), { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) {
    return new Response(auth.message, { status: auth.status });
  }

  try {
    const body = (await request.json()) as {
      userId?: string;
      email?: string;
      password?: string;
      fullName?: string;
      role?: UserRole;
    };

    const userId = String(body.userId || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "").trim();
    const fullName = String(body.fullName || "").trim();
    const role = body.role;

    if (!userId || !email || !fullName || !role) {
      return new Response("Missing required fields.", { status: 400 });
    }
    if (!["admin", "team", "client"].includes(role)) {
      return new Response("Invalid role.", { status: 400 });
    }
    if (userId === auth.userId && role !== "admin") {
      return new Response("Current admin cannot downgrade own role.", { status: 400 });
    }

    const admin = createAdminClient();
    const { error: authUpdateError } = await admin.auth.admin.updateUserById(userId, {
      email,
      password: password || undefined,
      user_metadata: { full_name: fullName },
    });
    if (authUpdateError) throw authUpdateError;

    const { error: profileUpdateError } = await admin
      .from("users")
      .update({ full_name: fullName, email, role })
      .eq("id", userId);
    if (profileUpdateError) throw profileUpdateError;

    return Response.json({ ok: true });
  } catch (err) {
    return new Response(errorMessage(err, "Failed to update user."), { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) {
    return new Response(auth.message, { status: auth.status });
  }

  try {
    const body = (await request.json()) as { userId?: string };
    const userId = String(body.userId || "").trim();

    if (!userId) {
      return new Response("Missing userId.", { status: 400 });
    }
    if (userId === auth.userId) {
      return new Response("You cannot delete your own admin account.", { status: 400 });
    }

    const admin = createAdminClient();
    const { error } = await admin.auth.admin.deleteUser(userId);

    if (error) throw error;
    return Response.json({ ok: true });
  } catch (err) {
    return new Response(errorMessage(err, "Failed to delete user."), { status: 500 });
  }
}
