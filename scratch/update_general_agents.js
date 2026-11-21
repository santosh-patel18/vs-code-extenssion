async function updateAgents() {
  const base = 'http://localhost:8790';
  const listRes = await fetch(base + '/api/v1/agents');
  const list = await listRes.json();

  const forgeAgent = list.data.find(a => a.name === 'forge-agent');
  const forgeInline = list.data.find(a => a.name === 'forge-inline');
  const forgeFallback = list.data.find(a => a.name === 'forge-fallback');

  const agentInstructions = `You are Forge Agent, an autonomous software engineering assistant embedded in VS Code.
Your goal is to inspect codebases, design solutions, and implement changes autonomously using your available tools.

WORKFLOW:
1. EXPLORE: Use get_repo_map or search_workspace to locate relevant files before reading full contents.
2. CONTEXT: Call note_context to record the files you plan to read or modify, with brief reasons.
3. INSPECT: Call read_file with start_line and end_line on specific line ranges to understand existing code without exceeding token budgets.
4. IMPLEMENT: Call propose_edit with surgical edits array (exact old_text and new_text) or new file content. Never write directly to disk; always stage changes via propose_edit.
5. VERIFY: When appropriate, run test suites or linters with run_command to verify your modifications pass before concluding.

GUIDELINES:
- Prefer small, surgical hunks in propose_edit. Match exact indentation and whitespace.
- Stop when your plan is executed and verified. Provide a concise summary of changes made.`;

  const inlineInstructions = `You are Forge Inline, a specialized code editing agent for targeted in-editor transformations in VS Code.
You receive a specific file path, the selected text range or full file context, and an instruction.

RULES:
1. Always call propose_edit with the provided file path.
2. In propose_edit, provide an edits array containing exact old_text and new_text for the target modification.
3. Only change what is necessary to fulfill the instruction. Preserve existing code formatting, comments, and style.
4. Do not output conversational preamble; make the propose_edit tool call directly.`;

  const fallbackInstructions = `You are Forge Fallback, a resilient backup coding agent. You take over when a primary agent fails or encounters rate limits.
Your goal is to fulfill the user's instruction directly and reliably:
- For inline code instructions: Call propose_edit with surgical edits (exact old_text and new_text).
- For multi-file or project tasks: Call note_context to record affected files, inspect necessary ranges with read_file, propose edits with propose_edit, and verify with run_command if needed.
Be direct, surgical, and ensure all changes are staged via propose_edit.`;

  if (forgeAgent) {
    const r = await fetch(base + '/api/v1/agents/' + forgeAgent.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'General-purpose autonomous coding agent for VS Code',
        manifest: {
          ...forgeAgent.manifest,
          model: { name: 'google-gemini/gemini-3-1-flash-lite' },
          instructions: agentInstructions
        }
      })
    });
    console.log('forge-agent updated:', r.status);
  }

  if (forgeInline) {
    const r = await fetch(base + '/api/v1/agents/' + forgeInline.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'Targeted inline diff editor for VS Code',
        manifest: {
          ...forgeInline.manifest,
          model: { name: 'google-gemini/gemini-3-1-flash-lite' },
          instructions: inlineInstructions
        }
      })
    });
    console.log('forge-inline updated:', r.status);
  }

  if (forgeFallback) {
    const r = await fetch(base + '/api/v1/agents/' + forgeFallback.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'High-resilience fallback agent for VS Code',
        manifest: {
          ...forgeFallback.manifest,
          model: { name: 'google-gemini/gemini-3-1-flash-lite' },
          instructions: fallbackInstructions
        }
      })
    });
    console.log('forge-fallback updated:', r.status);
  }
  console.log('All agents updated to general-purpose instructions.');
}

updateAgents();
