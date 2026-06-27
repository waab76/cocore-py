#!/usr/bin/env python3
"""End-to-end tool calling integration test.

Sends a real request with tools to a running vllm-mlx server and
verifies the model generates a structured tool call. Tests both
non-streaming and streaming paths.

Usage:
    python3 scripts/tool-calling-e2e.py [--host localhost] [--port 8000]
"""

import argparse
import json
import sys
import urllib.request
import urllib.error

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a city",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {
                        "type": "string",
                        "description": "The city name",
                    }
                },
                "required": ["city"],
            },
        },
    }
]

MESSAGES = [{"role": "user", "content": "What is the weather in Tokyo?"}]


def test_non_streaming(base_url: str, model: str) -> bool:
    """Test that a non-streaming request with tools returns structured tool_calls."""
    print("\n=== Non-streaming tool call ===")
    body = json.dumps(
        {
            "model": model,
            "messages": MESSAGES,
            "tools": TOOLS,
            "tool_choice": "auto",
            "max_tokens": 256,
        }
    ).encode()

    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"  FAIL: HTTP {e.code}: {e.read().decode()}")
        return False

    choice = data["choices"][0]
    message = choice["message"]
    finish_reason = choice.get("finish_reason")

    print(f"  finish_reason: {finish_reason}")
    print(f"  content: {message.get('content')}")
    print(f"  tool_calls: {json.dumps(message.get('tool_calls'), indent=2)}")

    if not message.get("tool_calls"):
        print("  FAIL: no tool_calls in response")
        return False

    tc = message["tool_calls"][0]
    if tc["function"]["name"] != "get_weather":
        print(f"  FAIL: expected function name 'get_weather', got '{tc['function']['name']}'")
        return False

    args = json.loads(tc["function"]["arguments"])
    if "city" not in args:
        print(f"  FAIL: expected 'city' in arguments, got {args}")
        return False

    print(f"  PASS: model called get_weather({args})")
    return True


def test_streaming(base_url: str, model: str) -> bool:
    """Test that a streaming request with tools returns tool_calls in SSE deltas.

    Requires a model+parser combination that supports structured streaming
    tool calls (e.g. Qwen2.5-3B-Instruct with hermes parser).
    """
    print("\n=== Streaming tool call ===")
    body = json.dumps(
        {
            "model": model,
            "messages": MESSAGES,
            "tools": TOOLS,
            "tool_choice": "auto",
            "max_tokens": 256,
            "stream": True,
        }
    ).encode()

    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
    )

    tool_call_chunks = []
    content_chunks = []
    finish_reason = None

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            buffer = ""
            for chunk in iter(lambda: resp.read(1024), b""):
                buffer += chunk.decode()
                while "\n\n" in buffer:
                    block, buffer = buffer.split("\n\n", 1)
                    for line in block.split("\n"):
                        if not line.startswith("data: "):
                            continue
                        data = line[6:]
                        if data == "[DONE]":
                            continue
                        try:
                            parsed = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        delta = parsed["choices"][0].get("delta", {})
                        if delta.get("tool_calls"):
                            tool_call_chunks.append(delta["tool_calls"])
                        if delta.get("content"):
                            content_chunks.append(delta["content"])
                        fr = parsed["choices"][0].get("finish_reason")
                        if fr:
                            finish_reason = fr
    except urllib.error.HTTPError as e:
        print(f"  FAIL: HTTP {e.code}: {e.read().decode()}")
        return False

    print(f"  content_chunks: {len(content_chunks)}")
    print(f"  tool_call_chunks: {len(tool_call_chunks)}")
    print(f"  finish_reason: {finish_reason}")

    if not tool_call_chunks:
        print("  FAIL: streaming did not emit structured delta.tool_calls")
        print("  This may indicate a model/parser incompatibility — try a")
        print("  larger model (e.g. Qwen2.5-3B-Instruct) with --tool-call-parser hermes")
        return False

    print(f"  tool_calls deltas: {json.dumps(tool_call_chunks, indent=2)}")
    if finish_reason != "tool_calls":
        print(f"  FAIL: expected finish_reason='tool_calls', got '{finish_reason}'")
        return False
    print("  PASS: streaming emitted structured tool_calls")
    return True


def test_multi_turn(base_url: str, model: str) -> bool:
    """Test multi-turn: send tool result back and verify model responds."""
    print("\n=== Multi-turn tool calling ===")
    # First request — get the tool call
    body = json.dumps(
        {
            "model": model,
            "messages": MESSAGES,
            "tools": TOOLS,
            "tool_choice": "auto",
            "max_tokens": 256,
        }
    ).encode()

    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"  FAIL: HTTP {e.code}: {e.read().decode()}")
        return False

    choice = data["choices"][0]
    message = choice["message"]
    if not message.get("tool_calls"):
        print("  SKIP: model didn't call a tool, can't test multi-turn")
        return True

    tool_call = message["tool_calls"][0]
    print(f"  Step 1: model called {tool_call['function']['name']}({tool_call['function']['arguments']})")

    # Second request — send tool result back
    messages = [
        {"role": "user", "content": "What is the weather in Tokyo?"},
        message,  # assistant message with tool_calls
        {
            "role": "tool",
            "tool_call_id": tool_call["id"],
            "content": json.dumps({"temperature": 22, "condition": "sunny"}),
        },
    ]

    body2 = json.dumps(
        {
            "model": model,
            "messages": messages,
            "tools": TOOLS,
            "max_tokens": 256,
        }
    ).encode()

    req2 = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=body2,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req2, timeout=30) as resp:
            data2 = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"  FAIL: HTTP {e.code}: {e.read().decode()}")
        return False

    response = data2["choices"][0]["message"]["content"]
    print(f"  Step 2: model responded: {response[:200]}")
    print("  PASS: multi-turn tool calling works")
    return True


def main():
    parser = argparse.ArgumentParser(description="Tool calling E2E test")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    base_url = f"http://{args.host}:{args.port}"

    # Get the model name
    try:
        with urllib.request.urlopen(f"{base_url}/v1/models", timeout=10) as resp:
            models = json.loads(resp.read())
        model = models["data"][0]["id"]
        print(f"Using model: {model}")
    except Exception as e:
        print(f"FAIL: could not connect to vllm-mlx at {base_url}: {e}")
        sys.exit(1)

    results = []
    results.append(("non-streaming", test_non_streaming(base_url, model)))
    results.append(("streaming", test_streaming(base_url, model)))
    results.append(("multi-turn", test_multi_turn(base_url, model)))

    print("\n=== Summary ===")
    all_pass = True
    for name, passed in results:
        status = "PASS" if passed else "FAIL"
        print(f"  {status}: {name}")
        if not passed:
            all_pass = False

    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
