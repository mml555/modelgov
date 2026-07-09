"""Tests for the Modelgov Python SDK, using respx to mock httpx transport."""

from __future__ import annotations

import contextlib
import json

import httpx
import pytest
import respx

from modelgov import (
    ModelgovClient,
    ModelgovError,
    PolicyBlockedError,
    SafetyBlockedError,
)

BASE_URL = "http://localhost:3000"
API_KEY = "sk-modelgov-test"


def make_client() -> ModelgovClient:
    return ModelgovClient(base_url=BASE_URL, api_key=API_KEY)


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
def test_chat_sends_context_and_multimodal_content() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(200, json=CHAT_SUCCESS_BODY)
    )

    with make_client() as client:
        client.chat(
            user_id="u",
            user_type="logged_in",
            feature="support_chat",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "What is on this receipt?"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                    ],
                }
            ],
            context=["Refunds are issued within 5 business days."],
        )

    sent = json.loads(route.calls.last.request.content)
    assert sent["context"] == ["Refunds are issued within 5 business days."]
    assert sent["messages"][0]["content"][0] == {"type": "text", "text": "What is on this receipt?"}
    assert sent["messages"][0]["content"][1]["type"] == "image_url"


@respx.mock
def test_chat_omits_context_when_absent() -> None:
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

    assert "context" not in json.loads(route.calls.last.request.content)


EMBEDDINGS_SUCCESS_BODY = {
    "embeddings": [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
    "model": "openai/text-embedding-3-small",
    "provider": "openai",
    "decision": "allow",
    "usage": {"inputTokens": 9},
    "cost": {"estimatedUsd": 0.0, "actualUsd": 0.0},
    "budgetRemaining": {
        "userDailyUsd": 0.24,
        "featureMonthlyUsd": None,
        "globalMonthlyUsd": 499.5,
    },
    "requestId": "req_77",
}


@respx.mock
def test_embed_success_batch_and_auth() -> None:
    route = respx.post(f"{BASE_URL}/v1/embeddings").mock(
        return_value=httpx.Response(200, json=EMBEDDINGS_SUCCESS_BODY)
    )

    with make_client() as client:
        res = client.embed(
            user_id="user_123",
            user_type="logged_in",
            feature="rag_ingest",
            input=["hello", "world"],
            model_class="cheap",
        )

    assert res == EMBEDDINGS_SUCCESS_BODY
    assert res["embeddings"][0] == [0.1, 0.2, 0.3]
    assert res["requestId"] == "req_77"

    request = route.calls.last.request
    assert request.headers["authorization"] == f"Bearer {API_KEY}"
    sent = json.loads(request.content)
    assert sent == {
        "userId": "user_123",
        "userType": "logged_in",
        "feature": "rag_ingest",
        "input": ["hello", "world"],
        "modelClass": "cheap",
    }


@respx.mock
def test_embed_accepts_single_string_input() -> None:
    route = respx.post(f"{BASE_URL}/v1/embeddings").mock(
        return_value=httpx.Response(200, json=EMBEDDINGS_SUCCESS_BODY)
    )

    with make_client() as client:
        client.embed(
            user_id="u",
            user_type="logged_in",
            feature="rag_ingest",
            input="just one",
        )

    sent = json.loads(route.calls.last.request.content)
    assert sent["input"] == "just one"


@respx.mock
def test_embed_maps_policy_blocked() -> None:
    respx.post(f"{BASE_URL}/v1/embeddings").mock(
        return_value=httpx.Response(
            403, json={"error": {"code": "budget_exceeded", "message": "over budget"}}
        )
    )

    with make_client() as client:
        with pytest.raises(PolicyBlockedError) as exc_info:
            client.embed(
                user_id="u",
                user_type="logged_in",
                feature="rag_ingest",
                input="x",
            )
    assert exc_info.value.code == "budget_exceeded"


DOCUMENT_SUCCESS_BODY = {
    "text": "extracted text",
    "pages": 2,
    "provider": "azure-di",
    "model": "azure-di/prebuilt-layout",
    "tables": [{"rowCount": 1, "columnCount": 1, "cells": [{"rowIndex": 0, "columnIndex": 0, "content": "cell"}]}],
    "fields": {"Total": {"content": "$5"}},
    "decision": "allow",
    "cost": {"estimatedUsd": 0.02, "actualUsd": 0.02},
    "budgetRemaining": None,
    "safety": {"piiMasked": False},
    "requestId": "req_88",
}


@respx.mock
def test_extract_document_success_and_auth() -> None:
    route = respx.post(f"{BASE_URL}/v1/documents/extract").mock(
        return_value=httpx.Response(200, json=DOCUMENT_SUCCESS_BODY)
    )

    with make_client() as client:
        res = client.extract_document(
            user_id="user_123",
            user_type="logged_in",
            feature="doc_review",
            provider="azure-di",
            model="prebuilt-layout",
            document={"base64": "ZmFrZQ=="},
            pages=2,
            idempotency_key="idem-doc-1",
        )

    assert res == DOCUMENT_SUCCESS_BODY
    assert res["tables"][0]["cells"][0]["content"] == "cell"
    request = route.calls.last.request
    assert request.headers["authorization"] == f"Bearer {API_KEY}"
    assert request.headers["idempotency-key"] == "idem-doc-1"
    sent = json.loads(request.content)
    assert sent == {
        "userId": "user_123",
        "userType": "logged_in",
        "feature": "doc_review",
        "provider": "azure-di",
        "model": "prebuilt-layout",
        "document": {"base64": "ZmFrZQ=="},
        "pages": 2,
    }


@respx.mock
def test_extract_document_maps_policy_blocked() -> None:
    respx.post(f"{BASE_URL}/v1/documents/extract").mock(
        return_value=httpx.Response(
            403, json={"error": {"code": "budget_exceeded", "message": "over budget"}}
        )
    )

    with make_client() as client, pytest.raises(PolicyBlockedError) as exc_info:
        client.extract_document(
            user_id="u",
            user_type="logged_in",
            feature="doc_review",
            provider="tesseract",
            document={"url": "https://example.com/doc.pdf"},
        )
    assert exc_info.value.code == "budget_exceeded"


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
    assert isinstance(err, ModelgovError)
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
        with pytest.raises(ModelgovError) as exc_info:
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
        with pytest.raises(ModelgovError) as exc_info:
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


TRANSACTIONS_BODY = {
    "since": "24h",
    "limit": 50,
    "transactions": [
        {
            "correlationId": "req-abc",
            "requests": 2,
            "externalEvents": 1,
            "actualCostUsd": 0.0123,
            "llmCostUsd": 0.0100,
            "externalCostUsd": 0.0023,
            "estimatedCostUsd": 0.0150,
            "firstSeen": "2026-07-09T00:00:00.000Z",
            "lastSeen": "2026-07-09T00:00:02.000Z",
        }
    ],
}


@respx.mock
def test_get_usage_transactions_passes_query_and_parses_rollup() -> None:
    route = respx.get(f"{BASE_URL}/v1/usage/transactions").mock(
        return_value=httpx.Response(200, json=TRANSACTIONS_BODY)
    )

    with make_client() as client:
        res = client.get_usage_transactions(since="7d", limit=50, project_id="proj_1")

    assert res == TRANSACTIONS_BODY
    assert res["transactions"][0]["correlationId"] == "req-abc"
    assert res["transactions"][0]["externalCostUsd"] == 0.0023
    params = route.calls.last.request.url.params
    assert params["since"] == "7d"
    assert params["limit"] == "50"  # int coerced to str for the query string
    assert params["projectId"] == "proj_1"
    assert route.calls.last.request.headers["authorization"] == f"Bearer {API_KEY}"


@respx.mock
def test_get_usage_transactions_omits_absent_params() -> None:
    route = respx.get(f"{BASE_URL}/v1/usage/transactions").mock(
        return_value=httpx.Response(200, json={"since": "24h", "limit": 20, "transactions": []})
    )

    with make_client() as client:
        client.get_usage_transactions()

    params = route.calls.last.request.url.params
    assert "since" not in params
    assert "limit" not in params
    assert "projectId" not in params


PROVIDER_HEALTH_BODY = {
    "status": "degraded",
    "models": [
        {"model": "openai/gpt-4o-mini", "provider": "openai", "healthy": True},
        {
            "model": "anthropic/claude",
            "provider": "anthropic",
            "healthy": False,
            "error": "timeout",
        },
    ],
}


@respx.mock
def test_get_provider_health_returns_body_and_auth() -> None:
    route = respx.get(f"{BASE_URL}/v1/admin/providers/health").mock(
        return_value=httpx.Response(200, json=PROVIDER_HEALTH_BODY)
    )

    with make_client() as client:
        res = client.get_provider_health()

    assert res == PROVIDER_HEALTH_BODY
    assert res["status"] == "degraded"
    assert res["models"][1]["healthy"] is False
    assert res["models"][1]["error"] == "timeout"
    assert route.calls.last.request.headers["authorization"] == f"Bearer {API_KEY}"


@respx.mock
def test_get_provider_health_maps_forbidden() -> None:
    respx.get(f"{BASE_URL}/v1/admin/providers/health").mock(
        return_value=httpx.Response(403, json={"error": {"code": "forbidden"}})
    )

    with make_client() as client, pytest.raises(ModelgovError) as exc:
        client.get_provider_health()

    assert exc.value.status == 403
    assert exc.value.code == "forbidden"


@respx.mock
def test_request_id_sent_as_correlation_header_across_calls() -> None:
    """The same request_id rolls related calls into one transaction server-side."""
    chat_route = respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(200, json=CHAT_SUCCESS_BODY)
    )
    doc_route = respx.post(f"{BASE_URL}/v1/documents/extract").mock(
        return_value=httpx.Response(
            200,
            json={
                "text": "ok",
                "pages": 1,
                "provider": "tesseract",
                "decision": "allow",
                "cost": {"estimatedUsd": 0.0, "actualUsd": 0.0},
                "budgetRemaining": None,
                "safety": {"piiMasked": False},
                "requestId": "req_doc",
            },
        )
    )

    with make_client() as client:
        client.chat(
            user_id="user_123",
            user_type="logged_in",
            feature="support_chat",
            messages=[{"role": "user", "content": "Hi"}],
            request_id="txn-42",
        )
        client.extract_document(
            user_id="user_123",
            user_type="logged_in",
            feature="doc_review",
            provider="tesseract",
            document={"base64": "ZmFrZQ=="},
            request_id="txn-42",
        )

    assert chat_route.calls.last.request.headers["x-request-id"] == "txn-42"
    assert doc_route.calls.last.request.headers["x-request-id"] == "txn-42"


@respx.mock
def test_request_id_forwarded_by_embed_explain_and_stream() -> None:
    """embed / explain / chat_stream also forward x-request-id (all 5 covered)."""
    embed_route = respx.post(f"{BASE_URL}/v1/embeddings").mock(
        return_value=httpx.Response(
            200,
            json={
                "embeddings": [[0.1]],
                "model": "m",
                "provider": "p",
                "decision": "allow",
                "usage": {"inputTokens": 1},
                "cost": {"estimatedUsd": 0.0, "actualUsd": 0.0},
                "budgetRemaining": None,
                "requestId": "req_e",
            },
        )
    )
    explain_route = respx.post(f"{BASE_URL}/v1/explain").mock(
        return_value=httpx.Response(200, json={"decision": "allow", "summary": "ok"})
    )
    stream_route = respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=SSE_STREAM
        )
    )

    with make_client() as client:
        client.embed(
            user_id="u", user_type="logged_in", feature="rag_ingest",
            input="x", request_id="rid",
        )
        client.explain(
            user_id="u", user_type="logged_in", feature="support_chat",
            request_id="rid",
        )
        list(
            client.chat_stream(
                user_id="u", user_type="logged_in", feature="support_chat",
                messages=[{"role": "user", "content": "hi"}], request_id="rid",
            )
        )

    assert embed_route.calls.last.request.headers["x-request-id"] == "rid"
    assert explain_route.calls.last.request.headers["x-request-id"] == "rid"
    assert stream_route.calls.last.request.headers["x-request-id"] == "rid"


@respx.mock
def test_no_request_id_header_when_absent() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(200, json=CHAT_SUCCESS_BODY)
    )

    with make_client() as client:
        client.chat(
            user_id="user_123",
            user_type="logged_in",
            feature="support_chat",
            messages=[{"role": "user", "content": "Hi"}],
        )

    assert "x-request-id" not in route.calls.last.request.headers


# --- Streaming --------------------------------------------------------------

SSE_STREAM = b"""data: {"choices":[{"delta":{"content":"Hello"}}]}

data: {"choices":[{"delta":{"content":", "}}]}

data: {"choices":[{"delta":{"content":"world"}}]}

data: {"choices":[{"delta":{}}]}

data: {"done":true,"model":"openai/gpt-4o-mini","usage":{"inputTokens":5,"outputTokens":3},"requestId":"req_99"}

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
def test_chat_stream_raises_on_mid_stream_error_frame() -> None:
    # The server emits `event: error` + a data frame with a `code` when a stream
    # fails after the first token. It must raise, not end silently (a truncated
    # answer would otherwise look complete).
    stream_bytes = (
        b'data: {"delta":"Hel"}\n\n'
        b'event: error\n'
        b'data: {"code":"provider_unavailable","message":"Stream interrupted"}\n\n'
    )
    respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=stream_bytes
        )
    )

    with make_client() as client:
        stream = client.chat_stream(
            user_id="u",
            user_type="logged_in",
            feature="support_chat",
            messages=[{"role": "user", "content": "Hi"}],
        )
        it = iter(stream)
        assert next(it) == "Hel"
        with pytest.raises(ModelgovError) as excinfo:
            next(it)
        assert excinfo.value.code == "provider_unavailable"


@respx.mock
def test_chat_stream_exposes_terminal_done_frame() -> None:
    respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=SSE_STREAM
        )
    )

    with make_client() as client:
        stream = client.chat_stream(
            user_id="u",
            user_type="logged_in",
            feature="support_chat",
            messages=[{"role": "user", "content": "Hi"}],
        )
        # done is not populated until the stream is fully consumed.
        assert stream.done is None
        chunks = list(stream)

    # The done frame is captured on `.done`, not yielded as a text chunk.
    assert chunks == ["Hello", ", ", "world"]
    assert stream.done is not None
    assert stream.done["model"] == "openai/gpt-4o-mini"
    assert stream.done["requestId"] == "req_99"
    assert stream.done["usage"] == {"inputTokens": 5, "outputTokens": 3}


@respx.mock
def test_chat_stream_done_is_none_without_terminal_frame() -> None:
    # A plain text-only stream (no {"done":true} frame) leaves .done as None.
    stream_bytes = b'data: {"delta":"hi"}\n\ndata: [DONE]\n\n'
    respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=stream_bytes
        )
    )

    with make_client() as client:
        stream = client.chat_stream(
            user_id="u",
            user_type="logged_in",
            feature="support_chat",
            messages=[{"role": "user", "content": "Hi"}],
        )
        chunks = list(stream)

    assert chunks == ["hi"]
    assert stream.done is None


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
def test_chat_stream_is_closable_early() -> None:
    # A caller abandoning a long stream can release it via close() /
    # contextlib.closing without AttributeError.
    stream_bytes = b'data: {"delta":"a"}\n\ndata: {"delta":"b"}\n\ndata: [DONE]\n\n'
    respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=stream_bytes
        )
    )

    with make_client() as client:
        with contextlib.closing(
            client.chat_stream(
                user_id="u",
                user_type="logged_in",
                feature="support_chat",
                messages=[{"role": "user", "content": "Hi"}],
            )
        ) as stream:
            first = next(iter(stream))
            assert first == "a"
        # Idempotent: closing again (and after contextlib already closed) is a no-op.
        stream.close()


@respx.mock
def test_chat_stream_context_manager_closes() -> None:
    stream_bytes = b'data: {"delta":"x"}\n\ndata: [DONE]\n\n'
    respx.post(f"{BASE_URL}/v1/chat").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=stream_bytes
        )
    )

    with make_client() as client:
        with client.chat_stream(
            user_id="u",
            user_type="logged_in",
            feature="support_chat",
            messages=[{"role": "user", "content": "Hi"}],
        ) as stream:
            assert list(stream) == ["x"]


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

    client = ModelgovClient(base_url=f"{BASE_URL}/", api_key=API_KEY)
    client.chat(
        user_id="u",
        user_type="logged_in",
        feature="support_chat",
        messages=[{"role": "user", "content": "Hi"}],
    )
    client.close()

    assert str(route.calls.last.request.url) == f"{BASE_URL}/v1/chat"
