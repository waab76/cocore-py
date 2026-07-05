"""Client for LMStudio's OpenAI-compatible local server: `/v1/models` for
capability discovery at Register time, `/v1/chat/completions` (streamed SSE)
for serving a job. No tool-calling / schema-guided decoding support in v1."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx


class LMStudioError(RuntimeError):
    pass


@dataclass
class ChatDelta:
    content: str
    finish_reason: str | None
    usage: tuple[int, int] | None


class LMStudioClient:
    def __init__(self, *, base_url: str, http: httpx.AsyncClient) -> None:
        self._base_url = base_url.rstrip("/")
        self._http = http

    async def list_models(self) -> list[str]:
        resp = await self._http.get(f"{self._base_url}/v1/models")
        if resp.status_code != 200:
            raise LMStudioError(f"/v1/models returned {resp.status_code}: {resp.text}")
        return [m["id"] for m in resp.json().get("data", [])]

    async def stream_chat(
        self, *, model: str, prompt: str, max_tokens: int
    ) -> AsyncIterator[ChatDelta]:
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        async with self._http.stream(
            "POST", f"{self._base_url}/v1/chat/completions", json=payload
        ) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                decoded = body.decode(errors="replace")
                raise LMStudioError(f"/v1/chat/completions returned {resp.status_code}: {decoded}")
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[len("data:") :].strip()
                if data == "[DONE]":
                    return
                try:
                    event = json.loads(data)
                    choices = event.get("choices") or []
                    if not choices:
                        usage = event.get("usage")
                        if usage is not None:
                            delta = ChatDelta(
                                content="",
                                finish_reason=None,
                                usage=(usage["prompt_tokens"], usage["completion_tokens"]),
                            )
                        else:
                            delta = None
                    else:
                        choice = choices[0]
                        content = (choice.get("delta") or {}).get("content", "")
                        finish_reason = choice.get("finish_reason")
                        delta = (
                            ChatDelta(content=content, finish_reason=finish_reason, usage=None)
                            if (content or finish_reason)
                            else None
                        )
                except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
                    raise LMStudioError(
                        f"malformed SSE event from /v1/chat/completions: {data!r}"
                    ) from e
                if delta is not None:
                    yield delta
