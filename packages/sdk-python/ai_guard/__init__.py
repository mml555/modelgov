"""Ai-Guard Python SDK.

A typed, idiomatic Python client for the Ai-Guard AI policy gateway. Mirrors
the TypeScript SDK's surface (``@ai-guard/sdk``).

Example:
    >>> from ai_guard import AiGuardClient
    >>> client = AiGuardClient(base_url="http://localhost:3000", api_key="sk-...")
    >>> res = client.chat(
    ...     user_id="user_123",
    ...     user_type="logged_in",
    ...     feature="support_chat",
    ...     model_class="cheap",
    ...     messages=[{"role": "user", "content": "Help me reset my password"}],
    ... )
    >>> print(res["message"]["content"])
"""

from .client import AiGuardClient
from .errors import AiGuardError, PolicyBlockedError, SafetyBlockedError
from .types import (
    BudgetRemaining,
    ChatMessage,
    ChatResponse,
    ChatResult,
    Cost,
    ExplainBudget,
    ExplainBudgetUsed,
    ExplainCost,
    ExplainRequested,
    ExplainResolved,
    ExplainResponse,
    ExplainResult,
    ExplainSafety,
    ResponseMessage,
    Safety,
    Usage,
    UsageResponse,
    UsageResult,
)

__version__ = "0.0.0"

__all__ = [
    "AiGuardClient",
    "AiGuardError",
    "PolicyBlockedError",
    "SafetyBlockedError",
    "ChatMessage",
    "ChatResponse",
    "ChatResult",
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
