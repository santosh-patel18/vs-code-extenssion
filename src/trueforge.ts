import * as vscode from 'vscode';
import { ForgeError, ErrorClass, UserMessages } from './errors';

export interface SseEvent {
  type: string;
  data: any;
}

export type EventCallback = (event: SseEvent) => void;

export class TrueForgeClient {
  private baseUrl: string;
  private currentAbortController: AbortController | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  public setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/+$/, '');
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Checks if TrueForge server is healthy and running
   */
  public async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/`, { method: 'GET' });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Registers the extension's MCP tool server in TrueForge (no auth headers)
   */
  public async registerMcpServer(port: number): Promise<void> {
    try {
      // First try to delete existing entry to avoid 409
      const listRes = await fetch(`${this.baseUrl}/api/v1/settings/mcp-servers`);
      if (listRes.ok) {
        const listJson = await listRes.json() as any;
        const existing = (listJson.data || []).find((s: any) => s.name === 'forge-tools' || s.manifest?.name === 'forge-tools');
        if (existing) {
          // Update existing entry
          await fetch(`${this.baseUrl}/api/v1/settings/mcp-servers/${existing.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              manifest: {
                type: 'remote',
                name: 'forge-tools',
                url: `http://127.0.0.1:${port}/mcp`,
                description: 'Forge VS Code extension editor capabilities'
              }
            })
          });
          console.log('[Forge] Updated forge-tools MCP registration in TrueForge.');
          return;
        }
      }

      // Register fresh
      const res = await fetch(`${this.baseUrl}/api/v1/settings/mcp-servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: {
            type: 'remote',
            name: 'forge-tools',
            url: `http://127.0.0.1:${port}/mcp`,
            description: 'Forge VS Code extension editor capabilities'
          }
        })
      });
      if (res.ok || res.status === 409) {
        console.log('[Forge] forge-tools MCP server registered in TrueForge.');
      } else {
        console.warn('[Forge] MCP server registration returned:', res.status);
      }
    } catch (e: any) {
      console.warn('[Forge] MCP auto-registration note:', e.message);
    }
  }

  /**
   * Creates a session with an agent definition by name
   */
  public async createSession(agentName: string): Promise<string> {
    const isUp = await this.ping();
    if (!isUp) {
      throw new ForgeError(
        ErrorClass.TF_UNREACHABLE,
        'FORGE_E_TF_UNREACHABLE',
        UserMessages.TF_NOT_RUNNING
      );
    }

    const res = await fetch(`${this.baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: { name: agentName }
      })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new ForgeError(
        ErrorClass.MODEL_FAIL,
        'FORGE_E_SESSION_FAIL',
        `Failed to create session with agent ${agentName}: ${text}`
      );
    }

    const json = (await res.json()) as any;
    return json.data?.id;
  }

  /**
   * Sends a turn and processes the SSE stream
   */
  public async sendTurn(
    sessionId: string,
    userMessage: string,
    onEvent: EventCallback,
    options?: { timeoutSec?: number }
  ): Promise<void> {
    this.currentAbortController = new AbortController();
    const timeoutSec = options?.timeoutSec || 180;

    const timeoutTimer = setTimeout(() => {
      if (this.currentAbortController) {
        this.currentAbortController.abort('Turn timeout exceeded');
      }
    }, timeoutSec * 1000);

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({
          input: [{ type: 'user.message', content: userMessage }]
        }),
        signal: this.currentAbortController.signal
      });

      if (!res.ok) {
        const text = await res.text();
        throw new ForgeError(
          ErrorClass.MODEL_FAIL,
          'FORGE_E_TURN_FAIL',
          `Turn request failed (${res.status}): ${text}`
        );
      }

      const body = res.body;
      if (!body) {
        throw new ForgeError(ErrorClass.STREAM_ERROR, 'FORGE_E_STREAM', 'No response body stream received');
      }

      const reader = (body as any).getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6);
            if (dataStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.state?.status === 'error' || (parsed.type === 'turn.done' && parsed.state?.status === 'error')) {
                const errMsg = parsed.state?.message || 'Model error occurred during turn';
                throw new ForgeError(ErrorClass.MODEL_FAIL, 'FORGE_E_TURN_FAILED', errMsg);
              }
              const evtType = parsed.type || 'message';
              onEvent({ type: evtType, data: parsed });
            } catch (parseErr: any) {
              if (parseErr instanceof ForgeError) {
                throw parseErr;
              }
              // Ignore non-json lines
            }
          }
        }
      }
    } finally {
      clearTimeout(timeoutTimer);
      this.currentAbortController = null;
    }
  }

  /**
   * Executes a turn with resilience: tries primary agent; if it fails, switches to fallback
   * First-event timeout: 15 seconds (required by brief)
   */
  public async executeWithFallback(
    primaryAgent: string,
    fallbackAgent: string,
    userMessage: string,
    onEvent: EventCallback
  ): Promise<void> {
    let usedFallback = false;

    try {
      const primarySessionId = await this.createSession(primaryAgent);

      // Race with 15s first-event timer
      let firstEventReceived = false;
      let primaryAborted = false;
      let primaryFailed = false;

      const firstEventTimer = setTimeout(() => {
        if (!firstEventReceived && this.currentAbortController) {
          primaryAborted = true;
          this.currentAbortController.abort('First event timeout — switching to fallback');
        }
      }, 15000);

      const wrappedOnEvent: EventCallback = (evt) => {
        const data = evt.data || {};
        const type = evt.type || data.type || '';

        // Catch model/turn errors streamed from TrueForge
        if (type === 'error' || type === 'turn.error' || type === 'model.error' || data.error || data.state?.status === 'error') {
          primaryFailed = true;
          clearTimeout(firstEventTimer);
          if (this.currentAbortController) {
            this.currentAbortController.abort('Primary agent model error');
          }
          return;
        }

        if (!firstEventReceived) {
          firstEventReceived = true;
          clearTimeout(firstEventTimer);
        }
        onEvent(evt);
      };

      try {
        await this.sendTurn(primarySessionId, userMessage, wrappedOnEvent, { timeoutSec: 180 });
        clearTimeout(firstEventTimer);
        if (primaryFailed || primaryAborted) {
          // Fall through to fallback
        } else {
          return; // success
        }
      } catch (err: any) {
        clearTimeout(firstEventTimer);
        console.warn('[Forge] Primary agent failed or timed out:', err.message);
      }
    } catch (err: any) {
      if (!usedFallback) {
        console.warn('[Forge] Primary agent session creation failed:', err.message);
      } else {
        throw err;
      }
    }

    // Fallback
    usedFallback = true;
    vscode.window.showWarningMessage(
      UserMessages.FALLBACK_NOTICE(primaryAgent, fallbackAgent)
    );
    onEvent({
      type: 'model.message.delta',
      data: { content: `\n\n⚠ [Resilience] Primary agent (${primaryAgent}) failed. Switched automatically to fallback agent (${fallbackAgent})...\n\n` }
    });

    try {
      const fallbackSessionId = await this.createSession(fallbackAgent);
      await this.sendTurn(fallbackSessionId, userMessage, onEvent, { timeoutSec: 180 });
    } catch (fallbackErr: any) {
      console.warn('[Forge] Fallback agent note:', fallbackErr.message);
    }
  }

  /**
   * Cancels the active turn immediately
   */
  public cancel() {
    if (this.currentAbortController) {
      this.currentAbortController.abort('User requested cancellation');
      this.currentAbortController = null;
    }
  }
}
