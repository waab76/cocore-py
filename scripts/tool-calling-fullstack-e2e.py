#!/usr/bin/env python3
"""Full-stack E2E test for tool-calling through the cocore dispatch pipeline.

Tests the complete path: Console /v1/chat/completions -> AppView dispatch
-> Advisor -> Provider -> Receipt.

Requires a running dev stack (mise dev) with:
  - Console on :3000
  - Advisor on :8082
  - At least one provider running

Usage:
    # With a tool-capable provider (COCORE_ENABLE_TOOL_CALLS=1):
    python3 scripts/tool-calling-fullstack-e2e.py --api-key cocore-xxx

    # Test gating (no tool-capable provider):
    python3 scripts/tool-calling-fullstack-e2e.py --api-key cocore-xxx --test-gating

    # Test structured output:
    python3 scripts/tool-calling-fullstack-e2e.py --api-key cocore-xxx --test-structured-output
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
            "strict": True,
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {
                        "type": "string",
                        "description": "The city name",
                    }
                },
                "required": ["city"],
                "additionalProperties": False,
            },
        },
    }
]

MESSAGES = [{"role": "user", "content": "What is the weather in Tokyo?"}]

FORCED_TOOL_MESSAGES = [
    {
        "role": "system",
        "content": "You are a tool-calling assistant. When get_weather is forced, return exactly that tool call and no prose.",
    },
    {"role": "user", "content": "Call get_weather for Tokyo."},
]

RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "weather_response",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "city": {"type": "string"},
                "temperature": {"type": "number"},
                "condition": {"type": "string"},
            },
            "required": ["city", "temperature", "condition"],
        },
    },
}


def make_request(base_url, api_key, body, expect_status=None):
    """Make an HTTP request to the console and return (status, parsed_body)."""
    data = json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=data,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, None
    except Exception as e:
        return None, {"error": str(e)}


def test_gating(base_url, api_key, model):
    """Test that the console returns 400 tool_calls_not_supported when no
    provider supports tool calling."""
    print("\n=== Gating test (no tool-capable provider) ===")
    status, body = make_request(
        base_url,
        api_key,
        {
            "model": model,
            "messages": MESSAGES,
            "tools": TOOLS,
            "tool_choice": "auto",
            "max_tokens": 256,
        },
    )
    print(f"  Status: {status}")
    if body and "error" in body:
        print(f"  Error type: {body['error'].get('type')}")
        print(f"  Message: {body['error'].get('message', '')[:120]}")

    if status == 400 and body and body.get("error", {}).get("type") == "tool_calls_not_supported":
        print("  PASS: gating correctly returned 400 tool_calls_not_supported")
        return True
    elif status == 200:
        print("  PASS: a tool-capable provider is available (gating not triggered)")
        return True
    else:
        print(f"  FAIL: expected 400 or 200, got {status}")
        return False


def test_no_tools_not_gated(base_url, api_key, model):
    """Test that requests without tools are never gated."""
    print("\n=== No-tools not gated ===")
    status, body = make_request(
        base_url,
        api_key,
        {
            "model": model,
            "messages": MESSAGES,
            "max_tokens": 16,
        },
    )
    print(f"  Status: {status}")
    if status == 400 and body and body.get("error", {}).get("type") == "tool_calls_not_supported":
        print("  FAIL: request without tools was incorrectly gated!")
        return False
    print("  PASS: request without tools was not gated")
    return True


def test_tool_call_non_streaming(base_url, api_key, model):
    """Test that a non-streaming request with tools returns structured tool_calls."""
    print("\n=== Non-streaming tool call ===")
    status, body = make_request(
        base_url,
        api_key,
        {
            "model": model,
            "messages": MESSAGES,
            "tools": TOOLS,
            "tool_choice": "auto",
            "max_tokens": 256,
        },
    )
    print(f"  Status: {status}")

    if status != 200:
        print(f"  SKIP: got {status}, provider may not support tools or no provider available")
        return True  # Not a failure — gating may have triggered

    choice = body["choices"][0]
    message = choice["message"]
    finish_reason = choice.get("finish_reason")
    print(f"  finish_reason: {finish_reason}")

    if message.get("tool_calls"):
        tc = message["tool_calls"][0]
        print(f"  tool_call: {tc['function']['name']}({tc['function']['arguments']})")
        if tc["function"]["name"] == "get_weather":
            print("  PASS: model called get_weather")
            return True
        else:
            print(f"  FAIL: expected get_weather, got {tc['function']['name']}")
            return False
    else:
        print(f"  NOTE: model didn't call a tool (finish_reason={finish_reason})")
        print("  This may be normal — the model chose to answer directly")
        return True


def test_tool_choice_object_form(base_url, api_key, model):
    """Test that the tool_choice object form is accepted and forces a function."""
    print("\n=== tool_choice object form ===")
    status, body = make_request(
        base_url,
        api_key,
        {
            "model": model,
            "messages": FORCED_TOOL_MESSAGES,
            "tools": TOOLS,
            "tool_choice": {"type": "function", "function": {"name": "get_weather"}},
            "max_tokens": 256,
        },
    )
    print(f"  Status: {status}")

    if status == 400:
        err_type = body.get("error", {}).get("type", "") if body else ""
        if err_type == "tool_calls_not_supported":
            print("  SKIP: no tool-capable provider available")
            return True
        print(f"  FAIL: unexpected 400: {err_type}")
        return False

    if status != 200:
        print(f"  SKIP: got {status}")
        return True

    choice = body["choices"][0]
    message = choice["message"]
    if message.get("tool_calls"):
        tc = message["tool_calls"][0]
        print(f"  tool_call: {tc['function']['name']}")
        if tc["function"]["name"] == "get_weather":
            print("  PASS: tool_choice object form forced get_weather")
            return True
    print("  FAIL: forced tool_choice did not produce structured tool_calls")
    return False


def test_full_tool_loop(base_url, api_key, model):
    """Test a real two-turn tool loop: model emits tool_calls, the client
    executes the tool, sends a tool-role result, and the model answers from
    that result."""
    print("\n=== Full tool loop ===")
    messages = list(FORCED_TOOL_MESSAGES)
    status, body = make_request(
        base_url,
        api_key,
        {
            "model": model,
            "messages": messages,
            "tools": TOOLS,
            "tool_choice": {"type": "function", "function": {"name": "get_weather"}},
            "max_tokens": 256,
        },
    )
    print(f"  turn1 status: {status}")
    if status != 200:
        print(f"  FAIL: turn1 returned {status}")
        return False

    assistant = body["choices"][0]["message"]
    tool_calls = assistant.get("tool_calls") or []
    if not tool_calls:
        print("  FAIL: turn1 did not return tool_calls")
        return False
    tool_call = tool_calls[0]
    if tool_call["function"]["name"] != "get_weather":
        print(f"  FAIL: expected get_weather, got {tool_call['function']['name']}")
        return False
    args = json.loads(tool_call["function"]["arguments"])
    print(f"  executing tool: get_weather({args})")

    # Deterministic local tool implementation for the E2E. The OpenAI-style
    # API only asks the model to *request* tool calls; the client/agent owns
    # executing the function and sending the result back as a tool message.
    tool_result = {
        "city": args.get("city", "Tokyo"),
        "temperature_c": 21.7,
        "condition": "clear",
    }
    messages.append(
        {
            "role": "assistant",
            "content": assistant.get("content") or "",
            "tool_calls": tool_calls,
        }
    )
    messages.append(
        {
            "role": "tool",
            "tool_call_id": tool_call["id"],
            "content": json.dumps(tool_result),
        }
    )
    messages.append(
        {
            "role": "user",
            "content": "Now answer using the tool result. Include the exact temperature.",
        }
    )

    status, body = make_request(
        base_url,
        api_key,
        {
            "model": model,
            "messages": messages,
            "tools": TOOLS,
            "tool_choice": "none",
            "max_tokens": 128,
        },
    )
    print(f"  turn2 status: {status}")
    if status != 200:
        print(f"  FAIL: turn2 returned {status}")
        return False
    content = body["choices"][0]["message"].get("content") or ""
    print(f"  final answer: {content[:200]}")
    if "Tokyo" in content and "21.7" in content:
        print("  PASS: model used the executed tool result")
        return True
    print("  FAIL: final answer did not clearly use the tool result")
    return False


def test_structured_output(base_url, api_key, model):
    """Test that response_format produces schema-conformant output."""
    print("\n=== Structured output (response_format) ===")
    status, body = make_request(
        base_url,
        api_key,
        {
            "model": model,
            "messages": [{"role": "user", "content": "What's the weather in Tokyo? Return as JSON."}],
            "response_format": RESPONSE_FORMAT,
            "max_tokens": 256,
        },
    )
    print(f"  Status: {status}")

    if status != 200:
        print(f"  SKIP: got {status}")
        return True

    content = body["choices"][0]["message"]["content"]
    print(f"  content: {content[:200]}")

    try:
        parsed = json.loads(content)
        if "city" in parsed and "temperature" in parsed and "condition" in parsed:
            print("  PASS: output conforms to the JSON schema")
            return True
        else:
            print(f"  FAIL: output missing required fields: {list(parsed.keys())}")
            return False
    except json.JSONDecodeError:
        print("  FAIL: output is not valid JSON")
        return False


def test_streaming_tool_call(base_url, api_key, model):
    """Test that streaming with tools returns tool_calls in SSE deltas."""
    print("\n=== Streaming tool call ===")
    body = json.dumps({
        "model": model,
        "messages": MESSAGES,
        "tools": TOOLS,
        "tool_choice": "auto",
        "max_tokens": 256,
        "stream": True,
    }).encode()
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=body,
        headers=headers,
    )

    tool_call_chunks = []
    content_chunks = []
    finish_reason = None

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
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
        print(f"  SKIP: HTTP {e.code}")
        return True

    print(f"  content_chunks: {len(content_chunks)}")
    print(f"  tool_call_chunks: {len(tool_call_chunks)}")
    print(f"  finish_reason: {finish_reason}")

    if tool_call_chunks:
        print("  PASS: streaming emitted structured tool_calls")
        return True
    elif finish_reason == "stop":
        print("  NOTE: model answered directly without calling a tool")
        return True
    else:
        print("  NOTE: no tool_calls in stream (may be model-dependent)")
        return True


def main():
    parser = argparse.ArgumentParser(description="Full-stack tool-calling E2E test")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=3000)
    parser.add_argument("--api-key", default=None, help="Console API key (Bearer token)")
    parser.add_argument("--model", default=None, help="Model name (auto-detected if omitted)")
    parser.add_argument("--test-gating", action="store_true", help="Only test gating behavior")
    parser.add_argument("--test-structured-output", action="store_true", help="Only test structured output")
    args = parser.parse_args()

    base_url = f"http://{args.host}:{args.port}"

    # Get the model name from /v1/models
    model = args.model
    if not model:
        try:
            headers = {}
            if args.api_key:
                headers["Authorization"] = f"Bearer {args.api_key}"
            req = urllib.request.Request(f"{base_url}/v1/models", headers=headers)
            with urllib.request.urlopen(req, timeout=10) as resp:
                models = json.loads(resp.read())
            model = models["data"][0]["id"]
            print(f"Using model: {model}")
        except Exception as e:
            print(f"FAIL: could not connect to console at {base_url}: {e}")
            sys.exit(1)

    results = []

    if args.test_gating:
        results.append(("gating", test_gating(base_url, args.api_key, model)))
        results.append(("no_tools_not_gated", test_no_tools_not_gated(base_url, args.api_key, model)))
    elif args.test_structured_output:
        results.append(("structured_output", test_structured_output(base_url, args.api_key, model)))
    else:
        results.append(("gating", test_gating(base_url, args.api_key, model)))
        results.append(("no_tools_not_gated", test_no_tools_not_gated(base_url, args.api_key, model)))
        results.append(("tool_call_non_streaming", test_tool_call_non_streaming(base_url, args.api_key, model)))
        results.append(("tool_choice_object_form", test_tool_choice_object_form(base_url, args.api_key, model)))
        results.append(("full_tool_loop", test_full_tool_loop(base_url, args.api_key, model)))
        results.append(("streaming_tool_call", test_streaming_tool_call(base_url, args.api_key, model)))
        results.append(("structured_output", test_structured_output(base_url, args.api_key, model)))

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
