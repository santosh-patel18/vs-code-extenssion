# Forge: VS Code Coding Agent on TrueForge

Forge is an editor-native coding agent built for the **TrueFoundry Forge-a-thon (Techfest 2026-27)**. It connects Visual Studio Code directly to [TrueForge](https://github.com/truefoundry/trueforge) local agent harness, delivering safe, fast, and multi-file code editing with per-hunk diff reviews, streaming, and model fallback.

---

## 🌟 Key Capabilities

1. **Inline Edit (Ctrl+Shift+I):** Select code in any file, enter an instruction in plain language, and review the proposed diff hunk-by-hunk directly in the editor using CodeLens.
2. **Autonomous Agent Mode:** Chat panel drives a TrueForge loop (`get_repo_map`, `search_workspace`, `find_symbols`, `read_file`, `note_context`, `propose_edit`, `run_command`) across multiple files without the user naming them.
3. **Context Assembly & Ledger:** Automatically captures repo context with token budgets, supports `@file` mentions, and visually records chosen files with reasons in the Context Ledger.
4. **Diff Safety & Undo:** Edits are never written silently to disk. Every change requires review, and applied changes can be reverted with one-click undo.
5. **Streaming, Cancel & Resilience:** Token streaming updates live; instant cancellation leaves the workspace consistent; automatic fallback takes over if the primary model fails.

---

## 🚀 Quickstart from a Clean Clone (AT-G)

### 1. Prerequisites
- **Node.js** v22.14 or newer (v24+ recommended)
- **VS Code** v1.90.0 or newer
- **Python** 3.10+ (for running Flask benchmark tests)

### 2. Start TrueForge Locally
Open a terminal and start TrueForge in local mode (SQLite backed, no external database needed):
```bash
npx @truefoundry/trueforge@latest
```
By default, the dashboard starts at `http://localhost:8790`.

### 3. Configure Your Model in TrueForge
Open `http://localhost:8790` in your browser:
1. Navigate to **Models / Providers**.
2. Add your provider (e.g. Gemini, Groq, Mistral, or a local OpenAI-compatible endpoint).
3. Connect your API key. (The extension never holds provider keys).

### 4. Register Forge Agents
In the project directory, run the setup script to register the agent definitions:
```bash
node register-agents.js
```
This registers `forge-inline`, `forge-agent`, and `forge-fallback`.

### 5. Install Dependencies & Build Extension
```bash
npm install
npm run build
```
This generates the single bundled file at `dist/extension.js`.

### 6. Launch the Extension in VS Code
1. Open this repository folder in VS Code.
2. Press **F5** (or open the **Run and Debug** view and click **Run Extension**).
3. A new **Extension Development Host** window will open with Forge active.

---

## 🧪 Running the Fixed Acceptance Tasks on Flask 3.1.3

Clone the benchmark repository:
```bash
git clone https://github.com/pallets/flask.git flask-benchmark
cd flask-benchmark
git checkout 3.1.3
```
Open `flask-benchmark` inside the Extension Development Host window.

### Task A: Inline Edit
1. Open `src/flask/helpers.py`.
2. Select the `get_debug_flag` function.
3. Press **Ctrl+Shift+I** (or `Cmd+Shift+I` on macOS).
4. Enter the prompt:
   ```text
   Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
   ```
5. Review the CodeLens buttons (`Accept Hunk` / `Reject Hunk` / `Accept All`) directly in the editor. Click **Accept All**.
6. Verify in the terminal:
   ```bash
   FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   ```
   *Expected output:* `False`.

### Task B: Agent Mode (Multi-File Change)
1. Click the **Forge Agent** icon in the Activity Bar to open the Agent Panel.
2. Without naming any files, enter:
   ```text
   Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
   ```
3. Watch the live tool execution and Context Ledger populate with reasons.
4. Review and accept the diffs across all modified files.
5. Verify in the terminal:
   ```bash
   pytest tests/test_cli.py -q
   ```

### Task C: Resilience (Model Fallback)
1. Temporarily configure an invalid endpoint or key in TrueForge.
2. Repeat Task A.
3. The extension detects the failure within ~15 seconds and automatically falls back to `forge-fallback` without blocking the editor.

---

## ⚙️ Configuration Settings

Accessible via `settings.json` in VS Code:
- `forge.trueforge.baseUrl`: URL of TrueForge (default: `http://localhost:8790`)
- `forge.agent.inline`: Inline edit agent name (default: `forge-inline`)
- `forge.agent.primary`: Primary agent name (default: `forge-agent`)
- `forge.agent.fallback`: Fallback agent name (default: `forge-fallback`)
- `forge.mcp.port`: MCP server local port (default: `8899`)
- `forge.timeouts.firstEvent`: Timeout for first event before fallback (default: `8`s)
- `forge.autoSave`: Auto-save files when changes are accepted (default: `true`)

---

## 📄 License & Attribution
- Open-source under the [MIT License](LICENSE).
- Upstream notices and dependencies documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
