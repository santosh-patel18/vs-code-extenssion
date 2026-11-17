# Models & Cost Log (For Techfest Write-Up Heading 5)

This log records the models used during testing, their host environments, and approximate costs as required by the competition specification.

## Configured Models in TrueForge

| Agent Definition | Model Identifier | Provider | Where it Ran | Tier / Cost |
|---|---|---|---|---|
| **forge-inline** | `google-gemini/gemini-3-1-flash-lite` | Google Gemini | Cloud API via TrueForge | Free Tier ($0.00) |
| **forge-agent** | `google-gemini/gemini-3-1-flash-lite` | Google Gemini | Cloud API via TrueForge | Free Tier ($0.00) |
| **forge-fallback** | `google-gemini/gemini-3-1-flash-lite` | Google Gemini | Cloud API via TrueForge | Free Tier ($0.00) |

## Benchmark Task Runs

| Task | Model | Prompt Tokens | Completion Tokens | Total Cost |
|---|---|---|---|---|
| Task A (Inline Edit) | Gemini 3.1 Flash Lite | ~1,200 | ~180 | $0.00 (Free Tier) |
| Task B (Agent Mode) | Gemini 3.1 Flash Lite | ~7,400 | ~1,100 | $0.00 (Free Tier) |
| Task C (Resilience) | Gemini 3.1 Flash Lite | ~1,200 | ~180 | $0.00 (Free Tier) |

## Model Switching Notes
To switch models, open the TrueForge dashboard (`http://localhost:8790`) or modify the `"model"` field in the corresponding `agents/*.json` definition and reload. No extension code change is required.
