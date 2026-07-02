"""FastAPI support-chat example — app auth first, then Ai-Guard policy.

Run:
    pip install -r requirements.txt
    export AI_GUARD_URL=http://localhost:3000
    export AI_GUARD_API_KEY=sk-ai-guard-api-local
    uvicorn app.main:app --reload

Then:
    curl -sX POST localhost:8000/support-chat \
      -H 'content-type: application/json' \
      -d '{"message":"How do I reset my password?"}'
"""
import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from ai_guard import AiGuardClient, PolicyBlockedError, SafetyBlockedError

app = FastAPI(title="support-chat")

ai = AiGuardClient(
    base_url=os.environ.get("AI_GUARD_URL", "http://localhost:3000"),
    api_key=os.environ.get("AI_GUARD_API_KEY", ""),
)


class ChatBody(BaseModel):
    message: str


def current_user() -> dict:
    # Replace with YOUR auth/RBAC. Ai-Guard does not authenticate end users.
    return {"id": "demo-user", "type": "logged_in"}


@app.post("/support-chat")
def support_chat(body: ChatBody):
    user = current_user()  # 1. product authorization is the app's job

    try:
        # 2. Ai-Guard enforces AI policy (budget / tokens / model access / safety).
        result = ai.chat(
            user_id=user["id"],
            user_type=user["type"],
            feature="support_chat",
            messages=[{"role": "user", "content": body.message}],
        )
    except SafetyBlockedError as e:
        raise HTTPException(status_code=400, detail={"error": "safety_blocked", "reasonCode": e.reason_code})
    except PolicyBlockedError as e:
        # Covers over-budget AND over-token-limit (reasonCode distinguishes).
        raise HTTPException(
            status_code=429,
            detail={"error": "policy_blocked", "reasonCode": e.reason_code, "budgetRemaining": e.budget_remaining},
        )

    return {
        "reply": result["message"]["content"],
        "requestId": result["requestId"],
        "decision": result["decision"],
    }
