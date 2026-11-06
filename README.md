# pi-tok-speed

Live inference speed in the Pi coding agent footer — two compact counters on the same line as the token and context usage stats, at the end of that line:

- **`S<value>ts`** — decode speed (output tokens/sec);
- **`PFL<value>ts`** — prefill speed (input tokens/sec).

Until the first measurement is available, dim placeholders `S--ts PFL--ts` are shown. While an assistant response streams, live estimates appear in accent color:

```
~/project (main)
↑12.3k ↓456 R90.2k W1.1k CH97.8% $0.421 42.3%/200k S32ts PFL5230ts   model-name • high
```

After the response finalizes, both values are re-computed from provider-reported usage and shown in green until the next response starts:

```
↑12.3k ↓512 R90.2k W1.1k CH97.8% $0.421 43.0%/200k S32ts PFL4890ts model-name • high
```

## Format

`S<value>ts` and `PFL<value>ts`, where `<value>` is an integer (fractional parts are **rounded** to the nearest whole number, not truncated). No icons, no decimals — compact by design. Color distinguishes state: dim = placeholder, accent = live estimate, green = exact value from finalized usage.

## How it works

The footer is rendered by `lib/footer-shared.ts` (a lookalike of the built-in footer with a registry for extra parts appended at the end of the stats line). Everything else from the stock footer is preserved: pwd + git branch + session name, token totals (`↑ ↓ R W CH% $cost`), context % with color thresholds (>70% warning, >90% error), model name and thinking level on the right, and `setStatus()` lines of other extensions.

### Decode speed (S)

- **Tokens** — provider-reported cumulative `usage.output` when available; otherwise estimated from the growing partial assistant message (text + thinking + tool-call arguments, ÷ 4 chars/token).
- **Timing** — measured from the first output token to the last (excludes time-to-first-token); for very short responses (<0.5 s of generation) timing falls back to request start.

### Prefill speed (PFL)

Per provider call:

- **t0** — `before_provider_headers` event (right before the HTTP request; falls back to `before_provider_request` if the headers hook does not fire for a transport);
- **t_first** — first output token observed on the assistant stream (`message_update`);
- **prefill time** = `t_first − t0`;
- **tokens** — live: estimate from the serialized request payload (~4 chars/token, via `before_provider_request.payload`); final: exact `usage.input + cacheRead + cacheWrite` from the finalized message.

## Install

The extension is plain TypeScript loaded by Pi's jiti runtime — no build step. Clone it into your global extensions directory as a subdirectory (it uses its internal `lib/` module, so install it as a directory, not a single copied file):

```sh
git clone git@github.com:gregory-evans/pi-tok-speed.git ~/.pi/agent/extensions/tok-speed
```

Pi auto-discovers `~/.pi/agent/extensions/*/index.ts`. Then run `/reload` (or restart Pi). Project-local installs work the same way under `.pi/extensions/`.

## Notes & limitations

- Speed is per assistant message. In a turn with multiple LLM calls (tool loops), each call is measured separately; the footer shows the latest completed call.
- The live estimates use ~4 chars/token; final values prefer provider-reported usage when present.
- **PFL is "apparent" speed**: `t_first − t0` includes network RTT and provider queueing. For local servers (Ollama/vLLM/llama.cpp) this is close to true prefill throughput; for cloud APIs the measured time is an upper bound on real prefill time.
- **Prompt caching inflates PFL**: cached tokens (`cacheRead`) are processed much faster but count in the numerator — with high cache hit rates the number can look unrealistically large. That is expected.
- Background provider calls (e.g. session title generation, if any) also trigger measurement hooks and may briefly update the counters.
- In non-TUI modes (`pi -p`, JSON) the counters are computed but not rendered (no custom footer).

## License

MIT
