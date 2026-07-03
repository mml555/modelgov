"""Typed exceptions raised by :class:`modelgov.client.ModelgovClient`.

Mirrors the TypeScript SDK's error hierarchy (``ModelgovError`` /
``PolicyBlockedError`` / ``SafetyBlockedError``) while surfacing the API's
structured error envelope (``code``, ``message``, ``details``, ``requestId``,
and block metadata from ``details``) as first-class attributes.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class ModelgovError(Exception):
    """Base error carrying the HTTP status and the API's structured error body.

    The Modelgov error envelope looks like::

        {
          "error": {
            "code": "policy_blocked",
            "message": "...",
            "details": {
              "auditRequestId": "req_42"      # audit-log row (block/safety only)
            },
            "requestId": "550e8400-..."       # HTTP trace id (UUID)
          }
        }

    Attributes:
        status: HTTP status code (0 if the request never got a response).
        code: The stable ``error.code`` string (e.g. ``"policy_blocked"``).
        message: Human-readable ``error.message``.
        details: The ``error.details`` object, if present.
        request_id: ``error.requestId`` — the HTTP trace id (UUID).
        audit_request_id: ``error.details.auditRequestId`` — the ``req_<n>``
            audit id, present on policy/safety/budget blocks. Use with
            ``modelgov requests show``.
        reason_code: ``error.details.reasonCode`` — stable machine-readable
            block reason (e.g. ``"daily_budget_exceeded"``), when present.
        budget_remaining: ``error.details.budgetRemaining`` — remaining budget
            headroom at decision time, when the API reports it.
        body: The full parsed response body.
    """

    def __init__(
        self,
        status: int,
        code: str,
        body: Any = None,
        *,
        message: Optional[str] = None,
    ) -> None:
        self.status = status
        self.code = code
        self.body = body

        error = body.get("error") if isinstance(body, dict) else None
        error_obj: Dict[str, Any] = error if isinstance(error, dict) else {}

        self.message: str = message or error_obj.get("message") or code
        self.details: Optional[Dict[str, Any]] = (
            error_obj.get("details") if isinstance(error_obj.get("details"), dict) else None
        )
        self.request_id: Optional[str] = error_obj.get("requestId")
        details = self.details if isinstance(self.details, dict) else {}
        self.audit_request_id: Optional[str] = (
            details.get("auditRequestId")
            if isinstance(details.get("auditRequestId"), str)
            else error_obj.get("auditRequestId")
        )
        # Block metadata surfaced from `error.details` as first-class attributes,
        # mirroring the TypeScript SDK's `reasonCode` / `budgetRemaining`.
        reason_code = details.get("reasonCode")
        self.reason_code: Optional[str] = reason_code if isinstance(reason_code, str) else None
        budget_remaining = details.get("budgetRemaining")
        self.budget_remaining: Optional[Dict[str, Any]] = (
            budget_remaining if isinstance(budget_remaining, dict) else None
        )

        super().__init__(f"modelgov request failed ({status}): {code} - {self.message}")


class PolicyBlockedError(ModelgovError):
    """Raised on 403 ``policy_blocked`` or ``budget_exceeded``.

    Inspect :attr:`~ModelgovError.body` / :attr:`~ModelgovError.details` for the
    block reason, and :attr:`~ModelgovError.audit_request_id` for the audit id.
    """


class SafetyBlockedError(ModelgovError):
    """Raised on 403 ``safety_blocked`` (PII or prompt injection)."""


__all__ = ["ModelgovError", "PolicyBlockedError", "SafetyBlockedError"]
