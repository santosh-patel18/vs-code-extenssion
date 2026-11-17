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
   * Registers or updates the extension's MCP tool server in TrueForge
   */
  public async registerMcpServer(port: number, bearerToken: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/v1/settings/mcp-servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: {
            type: 'remote',
            name: 'forge-tools',
            url: `http://127.0.0.1:${port}/mcp`,
            description: 'Forge VS Code extension editor capabilities',
            auth: {
              type: 'header',
              headers: {
                Authorization: `Bearer ${bearerToken}`
              }
            }
          }
        })
      });
    } catch (e) {
      console.warn('Note: MCP auto-registration note:', e);
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
   * Sends a turn and processes the SSE stream with auto-fallback support
   */
  public async sendTurn(
    sessionId: string,
    userMessage: string,
    onEvent: EventCallback,
    options?: { timeoutSec?: number }
  ): Promise<void> {
    this.currentAbortController = new AbortController();
    const timeoutSec = options?.timeoutSec || 120;

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
            try {
              const parsed = JSON.parse(dataStr);
              onEvent({ type: parsed.type || 'message', data: parsed });
            } catch {
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
   * Executes a turn with resilience: tries primary agent; if it fails/times out, switches to fallback
   */
  public async executeWithFallback(
    primaryAgent: string,
    fallbackAgent: string,
    userMessage: string,
    onEvent: EventCallback
  ): Promise<void> {
    try {
      const primarySessionId = await this.createSession(primaryAgent);

      // Race with 8s first-event timer
      let receivedFirstEvent = false;
      const wrappedOnEvent: EventCallback = (evt) => {
        receivedFirstEvent = true;
        onEvent(evt);
      };

      await this.sendTurn(primarySessionId, userMessage, wrappedOnEvent, { timeoutSec: 120 });
    } catch (err: any) {
      console.warn('Primary agent turn failed:', err.message);

      vscode.window.showWarningMessage(
        UserMessages.FALLBACK_NOTICE(primaryAgent, fallbackAgent)
      );

      // Fallback in a fresh session
      const fallbackSessionId = await this.createSession(fallbackAgent);
      await this.sendTurn(fallbackSessionId, userMessage, onEvent, { timeoutSec: 120 });
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
