from __future__ import annotations

import httpx
import pytest

from cocore_provider.lmstudio import LMStudioClient, LMStudioError


@pytest.mark.asyncio
async def test_list_models() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        return httpx.Response(200, json={"data": [{"id": "llama-3.1-8b"}, {"id": "qwen-7b"}]})

    transport = httpx.MockTransport(handler)
    async_client = httpx.AsyncClient(transport=transport)
    client = LMStudioClient(base_url="http://localhost:1234", http=async_client)
    models = await client.list_models()
    assert models == ["llama-3.1-8b", "qwen-7b"]


@pytest.mark.asyncio
async def test_stream_chat_yields_content_deltas_then_usage() -> None:
    sse_body = (
        'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n'
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n'
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'
        "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/chat/completions"
        return httpx.Response(200, content=sse_body, headers={"content-type": "text/event-stream"})

    transport = httpx.MockTransport(handler)
    async_client = httpx.AsyncClient(transport=transport)
    client = LMStudioClient(base_url="http://localhost:1234", http=async_client)
    deltas = [d async for d in client.stream_chat(model="llama-3.1-8b", prompt="hi", max_tokens=64)]

    assert [d.content for d in deltas] == ["Hel", "lo", "", ""]
    assert deltas[2].finish_reason == "stop"
    assert deltas[2].usage is None
    # the final usage-only event arrives as a distinct terminal delta
    assert deltas[-1].usage == (5, 2)
    assert deltas[-1].finish_reason is None


@pytest.mark.asyncio
async def test_stream_chat_http_error_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="internal error")

    transport = httpx.MockTransport(handler)
    async_client = httpx.AsyncClient(transport=transport)
    client = LMStudioClient(base_url="http://localhost:1234", http=async_client)
    with pytest.raises(LMStudioError):
        async for _ in client.stream_chat(model="m", prompt="hi", max_tokens=1):
            pass
