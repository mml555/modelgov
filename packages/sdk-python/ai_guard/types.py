"""Typed request/response models for the Ai-Guard API.

These mirror ``packages/sdk-typescript/src/types.ts`` and the shapes in
``packages/api/openapi.json``. Response models are :class:`typing.TypedDict`
so a decoded JSON body *is* the typed object with no conversion step — the
API already returns camelCase keys and the SDK returns them unchanged.

``ChatResult`` / ``ExplainResult`` / ``UsageResult`` are exported aliases used
by the client's return-type annotations.
"""

from __future__ import annotations

import sys
from typing import Any, Dict, List, Optional

if sys.version_info >= (3, 11):
    from typing import NotRequired, TypedDict
else:  # pragma: no cover - exercised on 3.9/3.10 runtimes
    from typing_extensions import NotRequired, TypedDict  # type: ignore


# --- Chat -------------------------------------------------------------------


class ChatMessage(TypedDict):
    """A single chat message. ``role`` is one of system/user/assistant/tool."""

    role: str
    content: str


class Usage(TypedDict):
    inputTokens: Optional[int]
    outputTokens: Optional[int]


class Cost(TypedDict):
    estimatedUsd: float
    actualUsd: float


class BudgetRemaining(TypedDict):
    userDailyUsd: float
    # null when no cap is configured (monthly_usd: 0).
    featureMonthlyUsd: Optional[float]
    globalMonthlyUsd: Optional[float]


class Safety(TypedDict):
    piiMasked: bool
    injectionBlocked: bool


class ResponseMessage(TypedDict):
    role: str
    content: str


class ChatResponse(TypedDict):
    """``200`` body of ``POST /v1/chat``."""

    message: ResponseMessage
    model: str
    decision: str  # "allow" | "degrade" | "fallback"
    reason: NotRequired[str]
    usage: Usage
    cost: Cost
    budgetRemaining: BudgetRemaining
    safety: Safety
    requestId: str  # audit id ("req_<n>")


# --- Explain ----------------------------------------------------------------


class ExplainRequested(TypedDict):
    userId: str
    userType: str
    feature: str
    modelClass: str


class ExplainResolved(TypedDict):
    modelClass: str
    model: str
    provider: str
    fallbackModel: NotRequired[str]


class ExplainSafety(TypedDict):
    preset: str
    pii: str
    promptInjection: str
    maxOutputTokens: int


class ExplainCost(TypedDict):
    estimatedUsd: float


class ExplainBudgetUsed(TypedDict):
    userDailyUsd: float
    userDailyRequests: int
    featureMonthlyUsd: float
    globalMonthlyUsd: float


class ExplainBudget(TypedDict):
    remaining: BudgetRemaining
    used: ExplainBudgetUsed
    permittedModels: List[str]
    dailyRequestLimit: int
    dailyRequestsRemaining: int


class ExplainResponse(TypedDict):
    """``200`` body of ``POST /v1/explain``."""

    decision: str  # "allow" | "block" | "degrade" | "fallback"
    reason: NotRequired[str]
    reasonCode: NotRequired[str]
    requested: ExplainRequested
    resolved: ExplainResolved
    safety: ExplainSafety
    cost: ExplainCost
    budget: ExplainBudget
    wouldCallModel: bool
    summary: str


# --- Usage ------------------------------------------------------------------

# The /v1/usage and /v1/usage/summary bodies are operator-facing and not fully
# fixed in the OpenAPI spec, so they are typed as a loose mapping.
UsageResponse = Dict[str, Any]


# --- Public aliases (match the naming used in the task/client signatures) ---

ChatResult = ChatResponse
ExplainResult = ExplainResponse
UsageResult = UsageResponse


__all__ = [
    "ChatMessage",
    "Usage",
    "Cost",
    "BudgetRemaining",
    "Safety",
    "ResponseMessage",
    "ChatResponse",
    "ChatResult",
    "ExplainRequested",
    "ExplainResolved",
    "ExplainSafety",
    "ExplainCost",
    "ExplainBudgetUsed",
    "ExplainBudget",
    "ExplainResponse",
    "ExplainResult",
    "UsageResponse",
    "UsageResult",
]
