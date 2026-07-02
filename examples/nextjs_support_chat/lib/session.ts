import { cookies } from "next/headers";

export type DemoUserType = "anonymous" | "logged_in" | "admin";

export interface DemoSession {
  userId: string;
  userType: DemoUserType;
}

/**
 * Demo auth — replace with your real session/JWT/Clerk/Auth.js integration.
 * Ai-Guard never sees passwords or OAuth tokens; it only receives userId + userType.
 */
export async function getSession(): Promise<DemoSession | null> {
  const jar = await cookies();
  const raw = jar.get("demo_session")?.value;
  if (!raw) return null;

  const userType = raw as DemoUserType;
  if (!["anonymous", "logged_in", "admin"].includes(userType)) return null;

  return {
    userId: `demo-${userType}`,
    userType,
  };
}
