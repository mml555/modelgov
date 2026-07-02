import { PolicyBlockedError, SafetyBlockedError } from "@ai-guard/sdk";
import { NextResponse } from "next/server";
import { ai } from "@/lib/ai-guard";
import { getSession } from "@/lib/session";

export async function POST(request: Request): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { message?: string };
  try {
    body = (await request.json()) as { message?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json({ error: "message_required" }, { status: 400 });
  }

  // Product authorization already happened via getSession().
  // Ai-Guard enforces AI policy only.
  try {
    const res = await ai.chat({
      userId: session.userId,
      userType: session.userType,
      feature: "support_chat",
      modelClass: "cheap",
      messages: [
        { role: "system", content: "You are a concise support assistant." },
        { role: "user", content: message },
      ],
    });

    return NextResponse.json({
      reply: res.message.content,
      model: res.model,
      decision: res.decision,
      budgetRemaining: res.budgetRemaining,
    });
  } catch (err) {
    if (err instanceof PolicyBlockedError) {
      return NextResponse.json(
        {
          error: "policy_blocked",
          reasonCode: err.reasonCode,
          message: err.message,
          budgetRemaining: err.budgetRemaining,
        },
        { status: 402 },
      );
    }
    if (err instanceof SafetyBlockedError) {
      return NextResponse.json({ error: "safety_blocked" }, { status: 400 });
    }
    console.error("ai-guard request failed", err);
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}
