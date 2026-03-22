import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/middleware";
import type { UserRole } from "@/lib/types/auth";

const publicRoutes = ["/login", "/forbidden"];

const routeRoleMap: Array<{ prefix: string; allowedRoles: UserRole[] }> = [
  { prefix: "/dashboard", allowedRoles: ["admin", "team", "client"] },
  { prefix: "/reports", allowedRoles: ["admin", "team", "client"] },
  { prefix: "/cogs", allowedRoles: ["admin", "team", "client"] },
  { prefix: "/performance", allowedRoles: ["admin", "team", "client"] },
  { prefix: "/settings", allowedRoles: ["admin", "team"] },
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (publicRoutes.some((route) => pathname.startsWith(route))) {
    const { supabase, response } = createClient(request);
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user && pathname === "/login") {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }

    return response;
  }

  const rule = routeRoleMap.find((item) => pathname.startsWith(item.prefix));
  if (!rule) {
    return NextResponse.next();
  }

  const { supabase, response } = createClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  const { data: roleData, error } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = roleData?.role as UserRole | undefined;

  if (error || !role || !rule.allowedRoles.includes(role)) {
    return NextResponse.redirect(new URL("/forbidden", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
