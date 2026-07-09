"""Typed request/response models for the Modelgov API.

These mirror ``packages/sdk-typescript/src/types.ts`` and the shapes in
``packages/api/openapi.json``. Response models are :class:`typing.TypedDict`
so a decoded JSON body *is* the typed object with no conversion step — the
API already returns camelCase keys and the SDK returns them unchanged.

``ChatResult`` / ``ExplainResult`` / ``UsageResult`` are exported aliases used
by the client's return-type annotations.
"""

from __future__ import annotations

import sys
from typing import Any, Dict, List, Optional, Union

if sys.version_info >= (3, 11):
    from typing import NotRequired, TypedDict
else:  # pragma: no cover - exercised on 3.9/3.10 runtimes
    from typing_extensions import NotRequired, TypedDict  # type: ignore


# --- Chat -------------------------------------------------------------------


class TextPart(TypedDict):
    """A text segment of a multimodal message (``type`` is ``"text"``)."""

    type: str
    text: str


class ImageUrl(TypedDict):
    url: str
    detail: NotRequired[str]  # "low" | "high" | "auto"


class ImagePart(TypedDict):
    """An image segment of a multimodal message (``type`` is ``"image_url"``).

    ``image_url.url`` is an http(s) URL or a ``data:`` URI (base64) — e.g. a
    page scan for OCR. Passed through to a vision model; the gateway still
    governs budget, audit, and text-part safety.
    """

    type: str
    image_url: ImageUrl


ContentPart = Union[TextPart, ImagePart]


class ChatMessage(TypedDict):
    """A single chat message. ``role`` is one of system/user/assistant/tool.

    ``content`` is a plain string, or a list of OpenAI-style content parts
    (text + images) for vision / multimodal features.
    """

    role: str
    content: Union[str, List[ContentPart]]


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
    # Token headroom; present when a token cap is configured, null otherwise.
    userDailyTokens: NotRequired[Optional[int]]
    featureMonthlyTokens: NotRequired[Optional[int]]
    globalMonthlyTokens: NotRequired[Optional[int]]


class Safety(TypedDict):
    piiMasked: bool
    injectionBlocked: bool
    # Present only for grounded features: whether the answer's citations were
    # verified against the provided context.
    grounded: NotRequired[bool]


class ResponseMessage(TypedDict):
    role: str
    content: str


class ChatResponse(TypedDict):
    """``200`` body of ``POST /v1/chat``."""

    message: ResponseMessage
    model: str
    # Provider of the model that ran, e.g. "openai", "openrouter", "ollama".
    provider: str
    decision: str  # "allow" | "degrade" | "fallback"
    reason: NotRequired[str]
    usage: Usage
    cost: Cost
    # null under hierarchical budgets (the node tree is the authority).
    budgetRemaining: Optional[BudgetRemaining]
    safety: Safety
    requestId: str  # audit id ("req_<n>")


class ChatStreamDone(TypedDict):
    """Terminal metadata frame emitted once a streamed completion finishes.

    Mirrors the TypeScript SDK's ``ChatStreamDone``: the ``data: {"done":true,...}``
    event the server sends just before ``data: [DONE]``.
    """

    done: bool  # always True
    model: str
    usage: Usage
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


# --- Embeddings -------------------------------------------------------------


class EmbeddingsUsage(TypedDict):
    inputTokens: Optional[int]


class EmbeddingsResponse(TypedDict):
    """``200`` body of ``POST /v1/embeddings``."""

    embeddings: List[List[float]]  # one vector per input, in request order
    model: str
    provider: str
    decision: str  # "allow" | "degrade" | "fallback"
    reason: NotRequired[str]
    usage: EmbeddingsUsage
    cost: Cost
    # null under hierarchical budgets (the node tree is the authority).
    budgetRemaining: Optional[BudgetRemaining]
    requestId: str


# --- Documents --------------------------------------------------------------


class DocumentSafety(TypedDict):
    piiMasked: bool


class DocumentTableCell(TypedDict):
    rowIndex: int
    columnIndex: int
    content: str
    rowSpan: NotRequired[int]
    columnSpan: NotRequired[int]


class DocumentTable(TypedDict):
    rowCount: int
    columnCount: int
    cells: List[DocumentTableCell]


class DocumentField(TypedDict):
    content: NotRequired[str]
    value: NotRequired[Any]
    type: NotRequired[str]
    confidence: NotRequired[float]


class DocumentEntity(TypedDict):
    docType: NotRequired[str]
    confidence: NotRequired[float]
    fields: Dict[str, DocumentField]


class DocumentExtractResponse(TypedDict):
    """``200`` body of ``POST /v1/documents/extract``."""

    text: str  # extracted text (PII-masked per the feature's plan)
    pages: int
    provider: str
    model: NotRequired[str]
    # Structure-aware model output (Azure DI prebuilt-layout / prebuilt-*).
    tables: NotRequired[List[DocumentTable]]
    fields: NotRequired[Dict[str, DocumentField]]
    documents: NotRequired[List[DocumentEntity]]
    decision: str  # "allow" | "degrade"
    reason: NotRequired[str]
    cost: Cost
    # null under hierarchical budgets (the node tree is the authority).
    budgetRemaining: Optional[BudgetRemaining]
    safety: DocumentSafety
    requestId: str


# --- Usage ------------------------------------------------------------------

# The /v1/usage and /v1/usage/summary bodies are operator-facing and not fully
# fixed in the OpenAPI spec, so they are typed as a loose mapping.
UsageResponse = Dict[str, Any]


class Transaction(TypedDict):
    """One correlation-id transaction in the cost rollup.

    Groups every request and externally-ingested cost event that shares an
    ``x-request-id`` (the ``correlationId``), so a chat call and a document
    extraction issued under the same id roll up together, with LLM vs external
    cost broken out.
    """

    correlationId: str
    requests: int
    externalEvents: int
    actualCostUsd: float
    llmCostUsd: float
    externalCostUsd: float
    estimatedCostUsd: float
    firstSeen: str  # ISO-8601
    lastSeen: str  # ISO-8601


class TransactionsResponse(TypedDict):
    """``200`` body of ``GET /v1/usage/transactions``."""

    since: str
    limit: int
    transactions: List[Transaction]  # top-N by cost


# --- Provider health --------------------------------------------------------


class ProviderModelHealth(TypedDict):
    model: str
    provider: str
    healthy: bool
    error: NotRequired[str]  # present when the model probe failed


class ProviderHealthResponse(TypedDict):
    """``200`` body of ``GET /v1/admin/providers/health``."""

    status: str  # "ok" | "degraded" | "fail" | "skipped"
    models: List[ProviderModelHealth]


# --- Public aliases (match the naming used in the task/client signatures) ---

ChatResult = ChatResponse
ExplainResult = ExplainResponse
EmbeddingsResult = EmbeddingsResponse
DocumentExtractResult = DocumentExtractResponse
UsageResult = UsageResponse
TransactionsResult = TransactionsResponse
ProviderHealthResult = ProviderHealthResponse


__all__ = [
    "ChatMessage",
    "TextPart",
    "ImageUrl",
    "ImagePart",
    "ContentPart",
    "Usage",
    "Cost",
    "BudgetRemaining",
    "Safety",
    "ResponseMessage",
    "ChatResponse",
    "ChatResult",
    "ChatStreamDone",
    "EmbeddingsUsage",
    "EmbeddingsResponse",
    "EmbeddingsResult",
    "DocumentSafety",
    "DocumentTableCell",
    "DocumentTable",
    "DocumentField",
    "DocumentEntity",
    "DocumentExtractResponse",
    "DocumentExtractResult",
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
    "Transaction",
    "TransactionsResponse",
    "TransactionsResult",
    "ProviderModelHealth",
    "ProviderHealthResponse",
    "ProviderHealthResult",
]
