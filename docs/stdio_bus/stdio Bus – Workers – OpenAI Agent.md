# OpenAI Agent

ACP agent for [stdio Bus kernel](https://github.com/stdiobus/stdiobus) that bridges the Agent Client Protocol to any OpenAI Chat Completions API-compatible endpoint.

## Overview

The OpenAI Agent translates ACP protocol messages (`initialize`, `newSession`, `prompt`, `cancel`) into HTTP POST requests to `/chat/completions` with `stream: true`, parses the SSE response token-by-token, and streams results back as `agent_message_chunk` session updates. It maintains per-session conversation history for multi-turn dialogues.

The agent is universal — it works with any endpoint implementing the OpenAI Chat Completions API:

| Provider | Base URL |
|----------|----------|
| OpenAI | `https://api.openai.com/v1` (default) |
| AWS Bedrock | `https://{region}.bedrock.amazonaws.com/openai/v1` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai/deployments/{deployment}` |
| Ollama | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LiteLLM | `http://localhost:4000/v1` |

## Architecture

```
stdio Bus kernel
    ↓ (NDJSON via stdin/stdout)
OpenAI Agent
    ├── SessionIdRouter (sessionId mapping)
    ├── AgentSideConnection (ACP JSON-RPC 2.0)
    ├── OpenAIAgent (protocol handler)
    │   ├── SessionManager (conversation state)
    │   └── ChatCompletionsClient (HTTP + SSE)
    │       └── SSEParser (line-by-line parsing)
    └── fetch() → OpenAI-compatible API
```

### Message Flow

1. Registry Launcher spawns `openai-agent` as a child process with environment variables
2. stdin receives NDJSON messages from stdio Bus kernel
3. `SessionIdRouter` strips `sessionId` from incoming messages, restores it on outgoing
4. `AgentSideConnection` + `ndJsonStream` handle JSON-RPC 2.0 framing
5. `OpenAIAgent` dispatches to the appropriate handler (`initialize`, `newSession`, `prompt`, `cancel`)
6. On `prompt`: ACP content blocks are converted to OpenAI messages, `ChatCompletionsClient` sends `POST {baseUrl}/chat/completions` with `stream: true`
7. SSE chunks are parsed line-by-line; `delta.content` tokens are forwarded via `sessionUpdate()`
8. On stream completion (`data: [DONE]`), the full response is saved to session history

## Installation

```bash
cd workers-registry/openai-agent
npm install
npm run build
```

## Usage

### With stdio Bus kernel via Registry Launcher (recommended)

The standard way to run the agent is through the Registry Launcher (`acp-registry` worker), which handles agent discovery, process management, and routing.

**1. Create a custom agents file** (`openai-custom-agents.json`):

```json
{
  "agents": [
    {
      "id": "openai-gpt4o",
      "name": "OpenAI GPT-4o",
      "version": "1.0.0",
      "description": "OpenAI Chat Completions API agent via ACP protocol",
      "distribution": {
        "npx": {
          "package": "@stdiobus/workers-registry",
          "args": ["openai-agent"],
          "env": {
            "OPENAI_BASE_URL": "https://api.openai.com/v1",
            "OPENAI_MODEL": "gpt-4o"
          }
        }
      }
    }
  ]
}
```

**2. Add the API key** to `api-keys.json`:

```json
{
  "OPENAI_API_KEY": "sk-..."
}
```

**3. Configure the stdio Bus pool** with `--custom-agents` pointing to your file:

```json
{
  "pools": [{
    "id": "acp-worker",
    "command": "npx",
    "args": [
      "@stdiobus/workers-registry", "acp-registry",
      "--custom-agents", "./openai-custom-agents.json"
    ],
    "env": {},
    "instances": 1
  }]
}
```

**4. Start stdio Bus:**

```bash
./stdio_bus --config config.json --tcp 127.0.0.1:9000
```

The Registry Launcher will discover the `openai-gpt4o` agent from the custom agents file and launch it on demand when a client sends a message with `"agentId": "openai-gpt4o"`.

Alternatively, instead of `--custom-agents` in args, you can set the environment variable:

```bash
export ACP_CUSTOM_AGENTS_PATH="./openai-custom-agents.json"
```

### Standalone Mode (direct launch)

You can also launch the worker directly via `npx` or `node` for testing:

```bash
export OPENAI_API_KEY="sk-..."

# Via npx (published package)
npx @stdiobus/workers-registry openai-agent

# Via node (local build)
node dist/index.js
```

Test with a raw NDJSON message:

```bash
echo '{"jsonrpc":"2.0","id":"1","method":"initialize","params":{"clientInfo":{"name":"test","version":"1.0"}}}' | \
  npx @stdiobus/workers-registry openai-agent
```

### With Ollama (local models)

Create a custom agents file for Ollama:

```json
{
  "agents": [
    {
      "id": "ollama-llama3",
      "name": "Ollama Llama 3",
      "version": "1.0.0",
      "distribution": {
        "npx": {
          "package": "@stdiobus/workers-registry",
          "args": ["openai-agent"],
          "env": {
            "OPENAI_BASE_URL": "http://localhost:11434/v1",
            "OPENAI_MODEL": "llama3"
          }
        }
      }
    }
  ]
}
```

No API key is needed for Ollama. Or launch directly:

```bash
export OPENAI_BASE_URL="http://localhost:11434/v1"
export OPENAI_MODEL="llama3"
npx @stdiobus/workers-registry openai-agent
```

### With AWS Bedrock

```json
{
  "agents": [
    {
      "id": "bedrock-claude",
      "name": "AWS Bedrock Claude",
      "version": "1.0.0",
      "distribution": {
        "npx": {
          "package": "@stdiobus/workers-registry",
          "args": ["openai-agent"],
          "env": {
            "OPENAI_BASE_URL": "https://us-east-1.bedrock.amazonaws.com/openai/v1",
            "OPENAI_MODEL": "anthropic.claude-3-sonnet-20240229-v1:0"
          }
        }
      }
    }
  ]
}
```

The `OPENAI_API_KEY` for Bedrock should be set via `api-keys.json`.

## Configuration

All configuration is via environment variables. No config files are needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL of the Chat Completions API endpoint |
| `OPENAI_API_KEY` | `''` (empty) | API key for authentication. A warning is logged if unset (may be fine for local endpoints like Ollama) |
| `OPENAI_MODEL` | `gpt-4o` | Model identifier passed in the `model` field of API requests |
| `OPENAI_SYSTEM_PROMPT` | *(unset)* | Optional system prompt prepended to every conversation |
| `OPENAI_MAX_TOKENS` | *(unset)* | Optional max tokens limit. Non-numeric values are ignored |
| `OPENAI_TEMPERATURE` | *(unset)* | Optional temperature (float). Non-numeric values are ignored |

## Protocol Support

### ACP Methods

| Method | Description | Status |
|--------|-------------|--------|
| `initialize` | Returns agent name, version, capabilities | ✅ Implemented |
| `session/new` | Creates session with unique ID and empty history | ✅ Implemented |
| `session/load` | Not supported (returns error) | ✅ Implemented |
| `authenticate` | No-op (returns void) | ✅ Implemented |
| `session/prompt` | Converts content → OpenAI messages, streams response | ✅ Implemented |
| `cancel` | Aborts in-flight HTTP request via AbortController | ✅ Implemented |

### Agent Capabilities

```json
{
  "protocolVersion": "2025-03-26",
  "agentInfo": { "name": "openai-agent", "version": "1.0.0" },
  "agentCapabilities": {
    "promptCapabilities": { "embeddedContext": true }
  },
  "authMethods": []
}
```

### Content Block Conversion

The agent converts ACP content blocks to OpenAI user messages:

| ACP Block Type | OpenAI Conversion |
|----------------|-------------------|
| `text` | Text content directly |
| `resource_link` | `[Resource: {name}] {uri}` |
| `resource` | `[Resource: {uri}]\n{text}` |
| `image` | `[Image: {mimeType}]` |

Multiple content blocks in a single prompt are joined with newlines into one user message.

## Project Structure

```
src/
├── index.ts              # Entry point (stdin/stdout piping, SessionIdRouter, signal handlers)
├── agent.ts              # OpenAIAgent class implementing ACP Agent interface
├── client.ts             # ChatCompletionsClient (native fetch + SSE stream reading)
├── sse-parser.ts         # Stateless SSE line parser (data/done/skip classification)
├── session.ts            # Session class (history, AbortController, cancellation)
├── session-manager.ts    # SessionManager (create, get, cancel by ID)
├── session-id-router.ts  # SessionIdRouter (stdio Bus ↔ ACP sessionId mapping)
├── config.ts             # Configuration loader from process.env
└── types.ts              # Shared TypeScript type definitions
```

## Error Handling

All errors are delivered as `agent_message_chunk` session updates followed by `{ stopReason: 'end_turn' }`, so the client always receives a complete response cycle.

| Condition | Error Message Pattern |
|-----------|----------------------|
| HTTP 401/403 | `Authentication error (HTTP {status}) calling {url}. Check your OPENAI_API_KEY.` |
| HTTP 429 | `Rate limit exceeded (HTTP 429) calling {url}. Please retry later.` |
| HTTP 500+ | `Server error (HTTP {status}) from {url}.` |
| Network failure | `Network error connecting to {url}: {message}` |
| Invalid SSE JSON | Logged to stderr, chunk skipped, stream continues |
| Unknown sessionId | JSON-RPC error response via ACP SDK |

## Graceful Shutdown

- `SIGTERM`: Aborts all active HTTP requests, waits for `connection.closed`, exits with code 0
- `SIGINT`: Same behavior as SIGTERM
- Uncaught exceptions: Logged to stderr, exits with code 1
- Unhandled rejections: Logged to stderr (process continues)

## Development

### Building

```bash
npm run build    # Compile TypeScript to dist/
npm run clean    # Remove dist/
```

### Testing

```bash
npm test         # Run all tests (unit + property-based)
```

The test suite includes 11 test files covering 5 unit test suites and 6 property-based test suites:

**Unit tests** (`tests/*.test.ts`):
- `config.test.ts` — default values, env var reading, numeric parsing, missing key warning
- `session.test.ts` — session creation, history management, cancellation lifecycle
- `sse-parser.test.ts` — SSE line parsing (data, done, skip, comments, invalid JSON)
- `agent.test.ts` — initialize, newSession, loadSession, authenticate, prompt with mocked client
- `client.test.ts` — HTTP error classification (401/403/429/500+), network errors, stream completion, cancellation

**Property-based tests** (`tests/*.property.test.ts`), each running 100+ iterations with `fast-check`:
- `config.property.test.ts` — configuration round-trip, numeric env var parsing
- `session.property.test.ts` — session uniqueness, history order preservation, cancellation semantics
- `sse-parser.property.test.ts` — SSE line classification, content round-trip, invalid JSON resilience
- `conversion.property.test.ts` — content block conversion, request construction with history, request invariants
- `error-handling.property.test.ts` — HTTP error classification across status code ranges
- `agent.property.test.ts` — initialize response field validation

### Key Design Decisions

- **Zero HTTP dependencies**: Uses native `fetch()` (Node.js 20+) instead of axios/node-fetch
- **Stateless SSE parser**: `parseLine()` is a pure function — no buffering state, easy to test and reason about
- **Per-session AbortController**: Each prompt gets a fresh `AbortController` via `resetCancellation()`, so cancellation of one request doesn't affect the next
- **Partial responses discarded on cancel**: When a request is cancelled, the incomplete assistant response is not saved to history, preventing corrupted conversation state
- **All logging to stderr**: stdout is reserved exclusively for NDJSON protocol messages

## Performance

- Session creation: O(1) — UUID generation + Map insertion
- Session lookup: O(1) — Map.get by sessionId
- SSE parsing: O(n) per line — single-pass string operations
- Memory: proportional to conversation history length per session (no persistence, no eviction)

## License

Apache License 2.0

Copyright (c) 2025–present Raman Marozau, Target Insight Function.

## Resources

- [stdio Bus kernel](https://github.com/stdiobus/stdiobus) — Core protocol and daemon
- [ACP SDK](https://www.npmjs.com/package/@agentclientprotocol/sdk) — Official Agent Client Protocol SDK
- [ACP Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) — Available agents
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat) — API reference
