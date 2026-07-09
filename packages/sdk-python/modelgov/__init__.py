"""Modelgov Python SDK.

A typed, idiomatic Python client for the Modelgov AI policy gateway. Mirrors
the TypeScript SDK's surface (``@modelgov/sdk``).

Example:
    >>> from modelgov import ModelgovClient
    >>> client = ModelgovClient(base_url="http://localhost:3000", api_key="sk-...")
    >>> res = client.chat(
    ...     user_id="user_123",
    ...     user_type="logged_in",
    ...     feature="support_chat",
    ...     model_class="cheap",
    ...     messages=[{"role": "user", "content": "Help me reset my password"}],
    ... )
    >>> print(res["message"]["content"])
"""

from .client import ChatStream, ModelgovClient
from .errors import ModelgovError, PolicyBlockedError, SafetyBlockedError
from .types import (
    BudgetRemaining,
    ChatMessage,
    ChatResponse,
    ChatResult,
    ChatStreamDone,
    ContentPart,
    Cost,
    DocumentExtractResponse,
    DocumentExtractResult,
    DocumentSafety,
    EmbeddingsResponse,
    EmbeddingsResult,
    EmbeddingsUsage,
    ExplainBudget,
    ExplainBudgetUsed,
    ExplainCost,
    ExplainRequested,
    ExplainResolved,
    ExplainResponse,
    ExplainResult,
    ExplainSafety,
    ImagePart,
    ImageUrl,
    ResponseMessage,
    Safety,
    TextPart,
    Usage,
    UsageResponse,
    UsageResult,
)

__version__ = "1.4.0"

__all__ = [
    "ModelgovClient",
    "ChatStream",
    "ModelgovError",
    "PolicyBlockedError",
    "SafetyBlockedError",
    "ChatMessage",
    "ChatResponse",
    "ChatResult",
    "ChatStreamDone",
    "TextPart",
    "ImageUrl",
    "ImagePart",
    "ContentPart",
    "EmbeddingsResponse",
    "EmbeddingsResult",
    "EmbeddingsUsage",
    "DocumentExtractResponse",
    "DocumentExtractResult",
    "DocumentSafety",
    "Usage",
    "Cost",
    "BudgetRemaining",
    "Safety",
    "ResponseMessage",
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
    "__version__",
]
