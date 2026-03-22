export type UserRole = "admin" | "team" | "client";

export const ROLE_LABEL: Record<UserRole, string> = {
  admin: "Admin",
  team: "Team",
  client: "Client",
};
