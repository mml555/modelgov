"""Synchronous Modelgov API client.

A thin, typed HTTP client over the Modelgov REST API. Policy enforcement is
always server-side; this client just shapes requests and maps errors. It
mirrors the TypeScript SDK (``packages/sdk-typescript``) in API surface and
ergonomics, adapted to idiomatic Python:

* keyword-only, snake_case call signatures (``user_id`` -> JSON ``userId``);
* structured exceptions (:class:`~modelgov.errors.ModelgovError` and
  subclasses) carrying the API error envelope;
* a streaming generator (:meth:`ModelgovClient.chat_stream`) over SSE.
"""

from __future__ import annotations

import json
from types import TracebackType
from typing import Any, Dict, Iterator, List, Mapping, Optional, Sequence, Type, Union

import httpx

from .errors import ModelgovError, PolicyBlockedError, SafetyBlockedError
from .types import (
    ChatMessage,
    ChatResult,
    ChatStreamDone,
    EmbeddingsResult,
    ExplainResult,
    UsageResult,
)

__all__ = ["ModelgovClient", "ChatStream"]

DEFAULT_TIMEOUT = 30.0


class ModelgovClient:
    """Synchronous client for the Modelgov API.

    Args:
        base_url: Base URL of the Modelgov API (e.g. ``http://localhost:3000``).
            A trailing slash is stripped.
        api_key: Sent as ``Authorization: Bearer <api_key>`` when provided.
        timeout: Request timeout in seconds (or any value ``httpx`` accepts).
            Defaults to 30s.
        http_client: Optional pre-built ``httpx.Client`` for custom transports
            or test injection. When provided, ``timeout`` is ignored and the
            caller owns the client's lifecycle.

    Example:
        >>> client = ModelgovClient(base_url="http://localhost:3000", api_key="sk-...")
        >>> res = client.chat(
        ...     user_id="user_123",
        ...     user_type="logged_in",
        ...     feature="support_chat",
        ...     messages=[{"role": "user", "content": "Hello"}],
        ... )
        >>> res["message"]["content"]

    The client is a context manager; use ``with ModelgovClient(...) as c:`` to
    close the underlying connection pool automatically.
    """

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        *,
        timeout: Union[float, httpx.Timeout, None] = DEFAULT_TIMEOUT,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._owns_client = http_client is None
        self._client = http_client or httpx.Client(timeout=timeout)

    # -- lifecycle ----------------------------------------------------------

    def close(self) -> None:
        """Close the underlying HTTP client (only if this instance owns it)."""
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "ModelgovClient":
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> None:
        self.close()

    # -- headers ------------------------------------------------------------

    def _headers(self, extra: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
        headers: Dict[str, str] = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        if extra:
            headers.update({k: v for k, v in extra.items() if v is not None})
        return headers

    # -- public API ---------------------------------------------------------

    def chat(
        self,
        *,
        user_id: str,
        user_type: str,
        feature: str,
        messages: Sequence[ChatMessage],
        context: Optional[Sequence[str]] = None,
        model_class: Optional[str] = None,
        requested_model_class: Optional[str] = None,
        input_tokens_estimate: Optional[int] = None,
        temperature: Optional[float] = None,
        project_id: Optional[str] = None,
        environment: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> ChatResult:
        """Run a guarded chat completion (``POST /v1/chat``).

        Args:
            user_id: Your end-user id. Required.
            user_type: Must match a user type in ``modelgov.yaml``. Required.
            feature: Registered feature name. Required.
            messages: List of ``{"role", "content"}`` messages. ``content`` is a
                string, or a list of content parts (``{"type": "text", ...}`` /
                ``{"type": "image_url", "image_url": {"url": ...}}``) for vision.
            context: Retrieved passages for a grounded feature (safety
                ``grounding: strict``). The gateway answers ONLY from these,
                forces verbatim citations, and verifies them; unverifiable
                answers become a safe refusal.
            model_class: Requested model class (e.g. ``"cheap"``). Maps to the
                API's ``modelClass`` field.
            requested_model_class: Alias for ``model_class``; if both are given,
                ``model_class`` wins. Provided for parity with callers that use
                the more explicit name.
            input_tokens_estimate: Optional pre-estimate for budget checks.
            temperature: Sampling temperature (0-2).
            project_id: Optional project scope.
            environment: Optional environment tag.
            idempotency_key: Sent as the ``Idempotency-Key`` header. Retrying
                with the same key + body replays the first result instead of
                re-charging budget or re-calling the model.
            metadata: Arbitrary key/value data stored on the audit log
                (max 32 keys). Does not affect policy.

        Returns:
            The decoded :class:`~modelgov.types.ChatResponse` body.

        Raises:
            SafetyBlockedError: 403 ``safety_blocked``.
            PolicyBlockedError: 403 ``policy_blocked`` / ``budget_exceeded``.
            ModelgovError: any other non-2xx response.
        """
        body = self._chat_body(
            user_id=user_id,
            user_type=user_type,
            feature=feature,
            messages=messages,
            context=context,
            model_class=model_class,
            requested_model_class=requested_model_class,
            input_tokens_estimate=input_tokens_estimate,
            temperature=temperature,
            project_id=project_id,
            environment=environment,
            metadata=metadata,
        )
        extra = {"idempotency-key": idempotency_key} if idempotency_key else None
        response = self._client.post(
            f"{self.base_url}/v1/chat",
            headers=self._headers(extra),
            json=body,
        )
        return self._handle_json(response)  # type: ignore[return-value]

    def chat_stream(
        self,
        *,
        user_id: str,
        user_type: str,
        feature: str,
        messages: Sequence[ChatMessage],
        context: Optional[Sequence[str]] = None,
        model_class: Optional[str] = None,
        requested_model_class: Optional[str] = None,
        input_tokens_estimate: Optional[int] = None,
        temperature: Optional[float] = None,
        project_id: Optional[str] = None,
        environment: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> "ChatStream":
        """Stream a guarded chat completion as incremental text chunks.

        Sends the same body as :meth:`chat` plus ``"stream": true`` and yields
        text deltas as they arrive. Returns a :class:`ChatStream`: iterate it in
        a ``for`` loop (or ``list(...)`` it) to consume the text chunks, then
        read :attr:`ChatStream.done` for the terminal metadata (final
        ``model`` / ``usage`` / ``requestId``). The underlying HTTP connection
        stays open until the stream is fully consumed (or closed); wrap it in
        ``contextlib.closing`` if you may abandon it early.

        SSE framing assumption:
            The server responds with ``Content-Type: text/event-stream`` and
            OpenAI-style Server-Sent Events — one event per ``data:`` line,
            terminated by a literal ``data: [DONE]`` sentinel. Each non-sentinel
            ``data:`` payload is JSON. This client extracts the incremental
            text from, in order of preference:

            * ``chunk["choices"][0]["delta"]["content"]`` (OpenAI chat delta),
            * ``chunk["delta"]`` or ``chunk["content"]`` or ``chunk["text"]``
              (simpler shapes the Modelgov API may emit).

            The terminal ``data: {"done": true, "model": ..., "usage": ...,
            "requestId": ...}`` frame the server sends just before ``[DONE]`` is
            captured on :attr:`ChatStream.done` rather than yielded as text — it
            mirrors the metadata the TypeScript SDK exposes.

            If a ``data:`` payload is not valid JSON it is yielded verbatim as a
            text chunk (tolerant of a plain-text delta stream). Empty deltas are
            skipped.

        Policy/safety blocks that happen *before* streaming starts are returned
        as a normal non-2xx JSON response and raised as the usual typed errors.

        Returns:
            A :class:`ChatStream` yielding ``str`` chunks of assistant text, in
            order, exposing ``.done`` once fully consumed.

        Raises:
            SafetyBlockedError / PolicyBlockedError / ModelgovError: on a non-2xx
                response received before the stream body begins.
        """
        body = self._chat_body(
            user_id=user_id,
            user_type=user_type,
            feature=feature,
            messages=messages,
            context=context,
            model_class=model_class,
            requested_model_class=requested_model_class,
            input_tokens_estimate=input_tokens_estimate,
            temperature=temperature,
            project_id=project_id,
            environment=environment,
            metadata=metadata,
        )
        body["stream"] = True

        extra: Dict[str, str] = {"accept": "text/event-stream"}
        if idempotency_key:
            extra["idempotency-key"] = idempotency_key

        return ChatStream(self, body, extra)

    def _iter_stream(
        self, body: Dict[str, Any], extra: Dict[str, str], stream: "ChatStream"
    ) -> Iterator[str]:
        """Drive one SSE response, yielding text and recording the done frame."""
        with self._client.stream(
            "POST",
            f"{self.base_url}/v1/chat",
            headers=self._headers(extra),
            json=body,
        ) as response:
            if response.status_code < 200 or response.status_code >= 300:
                # Materialize the error body, then map to a typed exception.
                response.read()
                self._raise_for_status(response)

            for line in response.iter_lines():
                chunk = _parse_sse_line(line)
                if chunk is _DONE:
                    break
                if isinstance(chunk, _DoneFrame):
                    stream._done = chunk.payload
                    continue
                if chunk:
                    yield chunk

    def explain(
        self,
        *,
        user_id: str,
        user_type: str,
        feature: str,
        model_class: Optional[str] = None,
        requested_model_class: Optional[str] = None,
        input_tokens_estimate: Optional[int] = None,
        project_id: Optional[str] = None,
        environment: Optional[str] = None,
    ) -> ExplainResult:
        """Dry-run policy evaluation (``POST /v1/explain``).

        Returns the decision, resolved model, safety plan, and a live budget
        snapshot *without* calling the model or reserving budget. Same identity
        fields as :meth:`chat`, but no ``messages``.
        """
        body: Dict[str, Any] = {
            "userId": user_id,
            "userType": user_type,
            "feature": feature,
        }
        resolved_model_class = model_class or requested_model_class
        if resolved_model_class is not None:
            body["modelClass"] = resolved_model_class
        if input_tokens_estimate is not None:
            body["inputTokensEstimate"] = input_tokens_estimate
        if project_id is not None:
            body["projectId"] = project_id
        if environment is not None:
            body["environment"] = environment

        response = self._client.post(
            f"{self.base_url}/v1/explain",
            headers=self._headers(),
            json=body,
        )
        return self._handle_json(response)  # type: ignore[return-value]

    def embed(
        self,
        *,
        user_id: str,
        user_type: str,
        feature: str,
        input: Union[str, Sequence[str]],
        model_class: Optional[str] = None,
        requested_model_class: Optional[str] = None,
        input_tokens_estimate: Optional[int] = None,
        project_id: Optional[str] = None,
        environment: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> EmbeddingsResult:
        """Embed one or more texts through the gateway (``POST /v1/embeddings``).

        Policy-checked (``feature`` + ``user_type``), budget-reserved, and
        audited exactly like :meth:`chat`, and raises the same typed errors on a
        ``403`` policy/budget block.

        Args:
            input: A single text, or a batch of texts to embed. A list is sent
                as a JSON array (one vector is returned per input, in order).

        Returns:
            The decoded :class:`~modelgov.types.EmbeddingsResponse` body, whose
            ``embeddings`` is one vector per input in request order.
        """
        body: Dict[str, Any] = {
            "userId": user_id,
            "userType": user_type,
            "feature": feature,
            "input": input if isinstance(input, str) else list(input),
        }
        resolved_model_class = model_class or requested_model_class
        if resolved_model_class is not None:
            body["modelClass"] = resolved_model_class
        if input_tokens_estimate is not None:
            body["inputTokensEstimate"] = input_tokens_estimate
        if project_id is not None:
            body["projectId"] = project_id
        if environment is not None:
            body["environment"] = environment
        if metadata is not None:
            body["metadata"] = dict(metadata)

        response = self._client.post(
            f"{self.base_url}/v1/embeddings",
            headers=self._headers(),
            json=body,
        )
        return self._handle_json(response)  # type: ignore[return-value]

    def get_usage(
        self,
        *,
        user_id: Optional[str] = None,
        feature: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> UsageResult:
        """Fetch budget counters and recent stats (``GET /v1/usage``).

        Requires an API key with the ``usage:read`` permission.
        """
        params: Dict[str, str] = {}
        if user_id is not None:
            params["userId"] = user_id
        if feature is not None:
            params["feature"] = feature
        if project_id is not None:
            params["projectId"] = project_id

        response = self._client.get(
            f"{self.base_url}/v1/usage",
            headers=self._headers(),
            params=params,
        )
        return self._handle_json(response)  # type: ignore[return-value]

    def get_usage_summary(
        self,
        *,
        feature: Optional[str] = None,
        user_type: Optional[str] = None,
        since: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> UsageResult:
        """Fetch aggregated cost/request summary (``GET /v1/usage/summary``).

        Args:
            since: ``"24h"``, ``"7d"``, or an ISO-8601 timestamp (default
                ``"24h"`` server-side).
        """
        params: Dict[str, str] = {}
        if feature is not None:
            params["feature"] = feature
        if user_type is not None:
            params["userType"] = user_type
        if since is not None:
            params["since"] = since
        if project_id is not None:
            params["projectId"] = project_id

        response = self._client.get(
            f"{self.base_url}/v1/usage/summary",
            headers=self._headers(),
            params=params,
        )
        return self._handle_json(response)  # type: ignore[return-value]

    # -- internals ----------------------------------------------------------

    @staticmethod
    def _chat_body(
        *,
        user_id: str,
        user_type: str,
        feature: str,
        messages: Sequence[ChatMessage],
        context: Optional[Sequence[str]],
        model_class: Optional[str],
        requested_model_class: Optional[str],
        input_tokens_estimate: Optional[int],
        temperature: Optional[float],
        project_id: Optional[str],
        environment: Optional[str],
        metadata: Optional[Mapping[str, Any]],
    ) -> Dict[str, Any]:
        """Build the camelCase JSON body the API expects, omitting None fields."""
        body: Dict[str, Any] = {
            "userId": user_id,
            "userType": user_type,
            "feature": feature,
            "messages": [dict(m) for m in messages],
        }
        if context is not None:
            body["context"] = list(context)
        resolved_model_class = model_class or requested_model_class
        if resolved_model_class is not None:
            body["modelClass"] = resolved_model_class
        if input_tokens_estimate is not None:
            body["inputTokensEstimate"] = input_tokens_estimate
        if temperature is not None:
            body["temperature"] = temperature
        if project_id is not None:
            body["projectId"] = project_id
        if environment is not None:
            body["environment"] = environment
        if metadata is not None:
            body["metadata"] = dict(metadata)
        return body

    def _handle_json(self, response: httpx.Response) -> Any:
        """Return the parsed JSON body, or raise a typed error on non-2xx."""
        if response.status_code < 200 or response.status_code >= 300:
            self._raise_for_status(response)
        try:
            return response.json()
        except (json.JSONDecodeError, ValueError):
            return {}

    @staticmethod
    def _raise_for_status(response: httpx.Response) -> None:
        """Map a non-2xx response to the appropriate ModelgovError subclass."""
        try:
            body = response.json()
        except (json.JSONDecodeError, ValueError):
            body = {}

        code = _error_code(body)
        if code == "safety_blocked":
            raise SafetyBlockedError(response.status_code, code, body)
        if code in ("policy_blocked", "budget_exceeded"):
            raise PolicyBlockedError(response.status_code, code, body)
        raise ModelgovError(response.status_code, code, body)


class ChatStream:
    """Iterable over a streamed chat completion's text chunks.

    Yields assistant text deltas (``str``) in order, exactly like the previous
    plain generator, so ``for chunk in stream:`` and ``list(stream)`` keep
    working. After the stream is fully consumed, :attr:`done` holds the terminal
    metadata frame (final ``model`` / ``usage`` / ``requestId``), matching the
    value the TypeScript SDK's ``chatStream`` returns. It is ``None`` until the
    stream finishes (or if the server sent no terminal frame).

    The request is lazy: nothing is sent until iteration begins. The generator
    is single-use.
    """

    def __init__(
        self, client: "ModelgovClient", body: Dict[str, Any], extra: Dict[str, str]
    ) -> None:
        self._done: Optional[ChatStreamDone] = None
        self._gen = client._iter_stream(body, extra, self)

    def __iter__(self) -> Iterator[str]:
        return self._gen

    def __next__(self) -> str:
        return next(self._gen)

    def close(self) -> None:
        """Close the underlying stream, releasing the HTTP response.

        Safe to call more than once and after full consumption. Lets a caller
        abandon a long stream early — the same guarantee the previous plain
        generator gave via ``generator.close()`` / ``contextlib.closing(...)``.
        """
        self._gen.close()

    def __enter__(self) -> "ChatStream":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    @property
    def done(self) -> Optional[ChatStreamDone]:
        """Terminal ``{model, usage, requestId}`` metadata, once fully consumed."""
        return self._done


def _error_code(body: Any) -> str:
    """Extract ``error.code`` from the envelope, tolerating loose shapes."""
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, str):
            return error
        if isinstance(error, dict):
            code = error.get("code")
            if isinstance(code, str):
                return code
    return "error"


# Sentinel returned by _parse_sse_line for the terminal `data: [DONE]` event.
_DONE = object()


class _DoneFrame:
    """Wraps the ``{"done": true, ...}`` metadata frame so it isn't yielded as text."""

    __slots__ = ("payload",)

    def __init__(self, payload: ChatStreamDone) -> None:
        self.payload = payload


def _parse_sse_line(line: str) -> Any:
    """Parse one SSE line into a text chunk, ``""``, ``_DONE``, or a ``_DoneFrame``.

    Returns ``_DONE`` for the ``[DONE]`` sentinel, a :class:`_DoneFrame` for the
    terminal ``{"done": true, ...}`` metadata frame, ``""`` for lines with no
    text delta (comments, blank lines, non-``data:`` fields, empty deltas), and
    the extracted text chunk otherwise. See :meth:`ModelgovClient.chat_stream`
    for the framing assumptions.
    """
    if not line:
        return ""
    stripped = line.strip()
    if not stripped or stripped.startswith(":"):
        # Blank line (event separator) or SSE comment.
        return ""
    if not stripped.startswith("data:"):
        # Ignore other SSE fields (event:, id:, retry:).
        return ""

    data = stripped[len("data:"):].strip()
    if data == "[DONE]":
        return _DONE
    if not data:
        return ""

    try:
        payload = json.loads(data)
    except (json.JSONDecodeError, ValueError):
        # Tolerate a plain-text delta stream.
        return data

    if isinstance(payload, dict) and payload.get("done") is True:
        return _DoneFrame(payload)  # type: ignore[arg-type]

    # Mid-stream error frame: the server emits `event: error` (dropped above as a
    # non-`data:` field) then a data frame carrying an error `code` when a stream
    # fails after the first token. Raise instead of returning "" — otherwise the
    # truncated answer ends cleanly and looks complete to the caller.
    if isinstance(payload, dict) and isinstance(payload.get("code"), str) and "delta" not in payload:
        msg = payload.get("message")
        raise ModelgovError(
            502,
            payload["code"],
            payload,
            message=msg if isinstance(msg, str) else None,
        )

    return _extract_delta(payload)


def _extract_delta(payload: Any) -> str:
    """Pull the incremental text out of a decoded SSE JSON payload."""
    if not isinstance(payload, dict):
        return ""

    # OpenAI-style: choices[0].delta.content
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            delta = first.get("delta")
            if isinstance(delta, dict):
                content = delta.get("content")
                if isinstance(content, str):
                    return content
            # Non-streaming-style fallback within a choice.
            message = first.get("message")
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                return message["content"]
            if isinstance(first.get("text"), str):
                return first["text"]

    # Simpler shapes the Modelgov API may emit.
    for key in ("delta", "content", "text"):
        value = payload.get(key)
        if isinstance(value, str):
            return value

    return ""
