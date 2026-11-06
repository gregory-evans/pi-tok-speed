# pi-tok-speed

Live inference speed (tokens/sec) in the Pi coding agent footer — on the same line as the token and context usage counters, at the end of that line.

Until the first measurement is available, a dim placeholder `S--ts` is shown. While an assistant response streams, it becomes a live estimate:

```
~/project (main)
↑12.3k ↓456 R90.2k W1.1k CH97.8% $0.421 42.3%/200k S32ts PFL--ts   model-name • high
```

After the response finalizes, the value is re-computed from provider-reported `usage.output` when available and shown in green until the next response starts:

```
↑12.3k ↓512 R90.2k W1.1k CH97.8% $0.421 43.0%/200k S32ts PFL5230ts model-name • high
```

## Format

`S<value>ts`, where `<value>` is decode throughput in output tokens per second. The value is an integer: fractional parts are **rounded** to the nearest whole number (not truncated). No icon, no decimals — compact by design.

## How it works

The footer is provided by the shared module `lib/footer-shared.ts` shipped in this repo, which renders a lookalike of the built-in footer plus registered parts at the end of the stats line. This extension registers its counter with order 100 (other extensions, e.g. pi-pfl-speed, register higher-order parts that appear after it):

- **Live estimate** — derived from the growing partial assistant message (text + thinking + tool-call arguments, ÷ 4 chars/token), or from provider-reported cumulative `usage.output` when the stream provides it.
- **Timing** — measured from the first output token to the last (excludes time-to-first-token); for very short responses (<0.5 s of generation) timing falls back to request start.
- **Final value** — recomputed on `message_end` using finalized usage; kept in the footer until the next assistant message starts.
- Everything else from the stock footer is preserved: pwd + git branch + session name, token totals (`↑ ↓ R W CH% $cost`), context % with color thresholds (>70% warning, >90% error), model name and thinking level on the right, and `setStatus()` lines of other extensions.

## Install

The extension is a single TypeScript file loaded by Pi's jiti runtime — no build step.

Clone it into your global extensions directory as a subdirectory:

```sh
git clone git@github.com:gregory-evans/pi-tok-speed.git ~/.pi/agent/extensions/tok-speed
```

Pi auto-discovers `~/.pi/agent/extensions/*/index.ts`. Then run `/reload` (or restart Pi).

Note: the extension uses the shared footer module at `lib/footer-shared.ts` inside this repo, so install it as a directory (not a single copied file). pi-pfl-speed depends on this repo for that module.

Project-local installs work the same way under `.pi/extensions/`.

## Notes & limitations

- Speed is per assistant message. In a turn with multiple LLM calls (tool loops), the footer shows the speed of the last finalized call while streaming, and updates live for each new call.
- The live estimate uses ~4 chars/token; the final value prefers provider-reported usage when present.
- In non-TUI modes (`pi -p`, JSON) the counter is computed but not rendered (no custom footer).

## License

MIT
