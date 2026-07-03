import { randomUUID } from "node:crypto";
import express from "express";
import {
  createModelgovClient,
  PolicyBlockedError,
  SafetyBlockedError,
} from "@modelgov/sdk";

/**
 * Jewgo-style event intake demo.
 *
 * Boundary:
 *   This app decides WHO may create event drafts (admin auth stub).
 *   Modelgov decides WHETHER the AI extraction call may run.
 */

const app = express();
app.use(express.json({ limit: "64kb" }));

const ai = createModelgovClient({
  baseUrl: process.env.MODELGOV_URL ?? "http://localhost:3090",
  apiKey: process.env.MODELGOV_API_KEY,
});

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "dev-admin-token";

interface AdminSession {
  userId: string;
  userType: "admin";
}

function requireAdmin(authHeader: string | undefined): AdminSession | null {
  if (authHeader !== `Bearer ${ADMIN_TOKEN}`) return null;
  return { userId: process.env.ADMIN_USER_ID ?? "admin_1", userType: "admin" };
}

app.post("/events/intake", async (req, res) => {
  const session = requireAdmin(req.header("authorization"));
  if (!session) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { flyerText, city, eventDraftId } = req.body as {
    flyerText?: string;
    city?: string;
    eventDraftId?: string;
  };

  if (!flyerText?.trim()) {
    return res.status(400).json({ error: "flyerText_required" });
  }

  const draftId = eventDraftId ?? `draft_${randomUUID().slice(0, 8)}`;

  const extractionPrompt = `Extract event fields as JSON with keys:
title, date, time, venue, city, description.
Return JSON only.

Flyer text:
${flyerText}`;

  try {
    const result = await ai.chat({
      userId: session.userId,
      userType: session.userType,
      feature: "event_flyer_extraction" as never,
      modelClass: "standard" as never,
      inputTokensEstimate: 1200,
      metadata: {
        app: "jewgo",
        eventDraftId: draftId,
        city: city ?? "unknown",
      },
      messages: [
        {
          role: "system",
          content:
            "You extract structured event data from flyer text. Output valid JSON only.",
        },
        { role: "user", content: extractionPrompt },
      ],
      temperature: 0,
    });

  // Correlate host app entity ↔ Modelgov audit row for debugging.
    console.log(
      `jewgo_event_draft=${draftId} modelgov_request_id=${result.requestId} decision=${result.decision}`,
    );

    let extraction: unknown;
    try {
      extraction = JSON.parse(result.message.content);
    } catch {
      extraction = { raw: result.message.content };
    }

    return res.status(201).json({
      draftId,
      city: city ?? null,
      extraction,
      aiGuard: {
        requestId: result.requestId,
        model: result.model,
        decision: result.decision,
        costUsd: result.cost.actualUsd,
        debug: `modelgov requests show ${result.requestId}`,
      },
    });
  } catch (err) {
    if (err instanceof PolicyBlockedError) {
      const body = err.body as { error?: { details?: { auditRequestId?: string; reasonCode?: string } } };
      const auditId = body.error?.details?.auditRequestId;
      console.warn(
        `jewgo_event_draft=${draftId} policy_blocked reason=${body.error?.details?.reasonCode} modelgov_request_id=${auditId ?? "n/a"}`,
      );
      return res.status(402).json({
        error: "ai_policy_blocked",
        reasonCode: body.error?.details?.reasonCode,
        aiGuardRequestId: auditId,
        message: "Event extraction blocked by AI policy (budget or model access).",
      });
    }
    if (err instanceof SafetyBlockedError) {
      return res.status(400).json({ error: "ai_safety_blocked" });
    }
    console.error("event intake failed", err);
    return res.status(502).json({ error: "upstream_error" });
  }
});

const port = Number(process.env.PORT ?? 3010);
app.listen(port, () => {
  console.log(`event intake app listening on http://localhost:${port}`);
  console.log("POST /events/intake with Authorization: Bearer <ADMIN_TOKEN>");
});
