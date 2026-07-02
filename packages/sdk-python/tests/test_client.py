"""Tests for the Ai-Guard Python SDK, using respx to mock httpx transport."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from ai_guard import (
    AiGuardClient,
    AiGuardError,
    PolicyBlockedError,
    SafetyBlockedError,
)

BASE_URL = "http://localhost:3000"
API_KEY = "sk-ai-guard-test"


def make_client() -> AiGuardClient:
    return AiGuardClient(base_url=BASE_URL, api_key=API_KEY)


CHAT_SUCCESS_BODY = {
    "message": {"role": "assistant", "content": "Hello there"},
    "model": "openai/gpt-4o-mini",
    "decision": "allow",
    "usage": {"inputTokens": 12, "outputTokens": 8},
    "cost": {"estimatedUsd": 0.0001, "actualUsd": 0.00008},
    "budgetRemaining": {
        "userDailyUsd": 0.24,
        "featureMonthlyUsd": None,
        "globalMonthlyUsd": 499.5,
    },
    "safety": {"piiMasked": False, "injectionBlocked": False},
    "requestId": "req_42",
}


@respx.mock
def test_chat_success_returns_body_and_sends_auth() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(200, json=CHAT_SUCCESS_BODY)
    )

    with make_client() as client:
        res = client.chat(
            user_id="user_123",
            user_type="logged_in",
            feature="support_chat",
            messages=[{"role": "user", "content": "Hi"}],
        )

    assert res == CHAT_SUCCESS_BODY
    assert res["message"]["content"] == "Hello there"
    assert res["requestId"] == "req_42"

    request = route.calls.last.request
    assert request.headers["authorization"] == f"Bearer {API_KEY}"
    assert request.headers["content-type"] == "application/json"


@respx.mock
def test_chat_converts_snake_case_to_camel_case() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(200, json=CHAT_SUCCESS_BODY)
    )

    with make_client() as client:
        client.chat(
            user_id="user_123",
            user_type="logged_in",
            feature="support_chat",
            messages=[{"role": "user", "content": "Hi"}],
            model_class="cheap",
            input_tokens_estimate=120,
            temperature=0.7,
            project_id="checkout",
            environment="production",
            metadata={"trace": "abc"},
        )

    sent = json.loads(route.calls.last.request.content)
    assert sent == {
        "userId": "user_123",
        "userType": "logged_in",
        "feature": "support_chat",
        "messages": [{"role": "user", "content": "Hi"}],
        "modelClass": "cheap",
        "inputTokensEstimate": 120,
        "temperature": 0.7,
        "projectId": "checkout",
        "environment": "production",
        "metadata": {"trace": "abc"},
    }
    # None-valued kwargs must be omitted entirely, not sent as null.
    assert "requestedModelClass" not in sent


@respx.mock
def test_requested_model_class_maps_to_model_class() -> None:
    respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(200, json=CHAT_SUCCESS_BODY)
    )
    route = respx.routes  # noqa: F841 (keep respx active)

    with make_client() as client:
        client.chat(
            user_id="u",
            user_type="logged_in",
            feature="support_chat",
            messages=[{"role": "user", "content": "Hi"}],
            requested_model_class="premium",
        )

    sent = json.loads(respx.calls.last.request.content)
    assert sent["modelClass"] == "premium"


@respx.mock
def test_idempotency_key_passed_as_header() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(200, json=CHAT_SUCCESS_BODY)
    )

    with make_client() as client:
        client.chat(
            user_id="user_123",
            user_type="logged_in",
            feature="support_chat",
            messages=[{"role": "user", "content": "Hi"}],
            idempotency_key="chat-user_123-session_9",
        )

    assert route.calls.last.request.headers["idempotency-key"] == "chat-user_123-session_9"


@respx.mock
def test_no_idempotency_header_when_absent() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(200, json=CHAT_SUCCESS_BODY)
    )

    with make_client() as client:
        client.chat(
            user_id="u",
            user_type="logged_in",
            feature="support_chat",
            messages=[{"role": "user", "content": "Hi"}],
        )

    assert "idempotency-key" not in route.calls.last.request.headers


@respx.mock
def test_policy_blocked_error_mapping() -> None:
    error_body = {
        "error": {
            "code": "policy_blocked",
            "message": "Model class not permitted for user type logged_in",
            "details": {
                "reason": "not permitted",
                "reasonCode": "model_class_not_permitted",
                "auditRequestId": "req_42",
            },
            "requestId": "550e8400-e29b-41d4-a716-446655440000",
        }
    }
    respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(403, json=error_body)
    )

    with make_client() as client:
        with pytest.raises(PolicyBlockedError) as exc_info:
            client.chat(
                user_id="u",
                user_type="logged_in",
                feature="support_chat",
                messages=[{"role": "user", "content": "Hi"}],
                model_class="premium",
            )

    err = exc_info.value
    assert isinstance(err, AiGuardError)
    assert err.status == 403
    assert err.code == "policy_blocked"
    assert err.message == "Model class not permitted for user type logged_in"
    assert err.details == {
        "reason": "not permitted",
        "reasonCode": "model_class_not_permitted",
        "auditRequestId": "req_42",
    }
    assert err.audit_request_id == "req_42"
    assert err.request_id == "550e8400-e29b-41d4-a716-446655440000"
    assert err.body == error_body


@respx.mock
def test_budget_exceeded_maps_to_policy_blocked() -> None:
    respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(
            403, json={"error": {"code": "budget_exceeded", "message": "over budget"}}
        )
    )

    with make_client() as client:
        with pytest.raises(PolicyBlockedError) as exc_info:
            client.chat(
                user_id="u",
                user_type="logged_in",
                feature="support_chat",
                messages=[{"role": "user", "content": "Hi"}],
            )
    assert exc_info.value.code == "budget_exceeded"


@respx.mock
def test_safety_blocked_error_mapping() -> None:
    respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(
            403, json={"error": {"code": "safety_blocked", "message": "PII detected"}}
        )
    )

    with make_client() as client:
        with pytest.raises(SafetyBlockedError) as exc_info:
            client.chat(
                user_id="u",
                user_type="logged_in",
                feature="support_chat",
                messages=[{"role": "user", "content": "my ssn is ..."}],
            )
    assert exc_info.value.code == "safety_blocked"
    assert exc_info.value.status == 403


@respx.mock
def test_generic_error_maps_to_base_error() -> None:
    respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(
            401, json={"error": {"code": "unauthorized", "message": "bad key"}}
        )
    )

    with make_client() as client:
        with pytest.raises(AiGuardError) as exc_info:
            client.chat(
                user_id="u",
                user_type="logged_in",
                feature="support_chat",
                messages=[{"role": "user", "content": "Hi"}],
            )
    err = exc_info.value
    assert not isinstance(err, (PolicyBlockedError, SafetyBlockedError))
    assert err.code == "unauthorized"
    assert err.status == 401


@respx.mock
def test_error_with_non_json_body() -> None:
    respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(500, text="Internal Server Error")
    )

    with make_client() as client:
        with pytest.raises(AiGuardError) as exc_info:
            client.chat(
                user_id="u",
                user_type="logged_in",
                feature="support_chat",
                messages=[{"role": "user", "content": "Hi"}],
            )
    assert exc_info.value.code == "error"
    assert exc_info.value.status == 500


@respx.mock
def test_explain_success() -> None:
    explain_body = {
        "decision": "block",
        "reason": "model_class 'premium' is not permitted",
        "requested": {
            "userId": "u",
            "userType": "logged_in",
            "feature": "support_chat",
            "modelClass": "premium",
        },
        "resolved": {"modelClass": "premium", "model": "openai/gpt-5", "provider": "openai"},
        "safety": {"preset": "strict", "pii": "block", "promptInjection": "block", "maxOutputTokens": 500},
        "cost": {"estimatedUsd": 0.0012},
        "budget": {
            "remaining": {"userDailyUsd": 0.24, "featureMonthlyUsd": None, "globalMonthlyUsd": 499.5},
            "used": {"userDailyUsd": 0.01, "userDailyRequests": 3, "featureMonthlyUsd": 0.02, "globalMonthlyUsd": 0.5},
            "permittedModels": ["cheap", "standard"],
            "dailyRequestLimit": 50,
            "dailyRequestsRemaining": 47,
        },
        "wouldCallModel": False,
        "summary": "Decision: block",
    }
    route = respx.post(f"{BASE_URL}/v1/explain").mock(
        return_value=httpx.Response(200, json=explain_body)
    )

    with make_client() as client:
        res = client.explain(
            user_id="u",
            user_type="logged_in",
            feature="support_chat",
            model_class="premium",
        )

    assert res["decision"] == "block"
    assert res["wouldCallModel"] is False
    sent = json.loads(route.calls.last.request.content)
    assert sent == {
        "userId": "u",
        "userType": "logged_in",
        "feature": "support_chat",
        "modelClass": "premium",
    }
    assert "messages" not in sent


@respx.mock
def test_get_usage_passes_query_params() -> None:
    route = respx.get(f"{BASE_URL}/v1/usage").mock(
        return_value=httpx.Response(200, json={"userDailyUsd": 0.24})
    )

    with make_client() as client:
        res = client.get_usage(user_id="user_123", feature="support_chat")

    assert res == {"userDailyUsd": 0.24}
    request = route.calls.last.request
    assert request.url.params["userId"] == "user_123"
    assert request.url.params["feature"] == "support_chat"
    assert request.headers["authorization"] == f"Bearer {API_KEY}"


@respx.mock
def test_get_usage_summary_passes_since() -> None:
    route = respx.get(f"{BASE_URL}/v1/usage/summary").mock(
        return_value=httpx.Response(200, json={"totalUsd": 1.23})
    )

    with make_client() as client:
        res = client.get_usage_summary(feature="support_chat", since="7d")

    assert res == {"totalUsd": 1.23}
    params = route.calls.last.request.url.params
    assert params["feature"] == "support_chat"
    assert params["since"] == "7d"


# --- Streaming --------------------------------------------------------------

SSE_STREAM = b"""data: {"choices":[{"delta":{"content":"Hello"}}]}

data: {"choices":[{"delta":{"content":", "}}]}

data: {"choices":[{"delta":{"content":"world"}}]}

data: {"choices":[{"delta":{}}]}

data: [DONE]

"""


@respx.mock
def test_chat_stream_yields_chunks() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=SSE_STREAM,
        )
    )

    with make_client() as client:
        chunks = list(
            client.chat_stream(
                user_id="u",
                user_type="logged_in",
                feature="support_chat",
                messages=[{"role": "user", "content": "Hi"}],
            )
        )

    assert chunks == ["Hello", ", ", "world"]
    assert "".join(chunks) == "Hello, world"

    sent = json.loads(route.calls.last.request.content)
    assert sent["stream"] is True
    assert route.calls.last.request.headers["accept"] == "text/event-stream"


@respx.mock
def test_chat_stream_supports_simple_delta_shape() -> None:
    stream = b'data: {"delta":"foo"}\n\ndata: {"delta":"bar"}\n\ndata: [DONE]\n\n'
    respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=stream
        )
    )

    with make_client() as client:
        chunks = list(
            client.chat_stream(
                user_id="u",
                user_type="logged_in",
                feature="support_chat",
                messages=[{"role": "user", "content": "Hi"}],
            )
        )
    assert chunks == ["foo", "bar"]


@respx.mock
def test_chat_stream_raises_on_pre_stream_error() -> None:
    respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(
            403, json={"error": {"code": "safety_blocked", "message": "blocked"}}
        )
    )

    with make_client() as client:
        with pytest.raises(SafetyBlockedError):
            list(
                client.chat_stream(
                    user_id="u",
                    user_type="logged_in",
                    feature="support_chat",
                    messages=[{"role": "user", "content": "Hi"}],
                )
            )


@respx.mock
def test_base_url_trailing_slash_stripped() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(200, json=CHAT_SUCCESS_BODY)
    )

    client = AiGuardClient(base_url=f"{BASE_URL}/", api_key=API_KEY)
    client.chat(
        user_id="u",
        user_type="logged_in",
        feature="support_chat",
        messages=[{"role": "user", "content": "Hi"}],
    )
    client.close()

    assert str(route.calls.last.request.url) == f"{BASE_URL}/v1/chat"
