import { FormEvent, KeyboardEvent, useEffect, useMemo, useState } from "react";
import { PairingQrScanner } from "./components/PairingQrScanner";
import { KoderClient } from "./lib/client";
import { parsePairingPayload } from "./lib/protocol";
import type { ApprovalRequest, ClientSnapshot, ConversationMessage, TrustedMacRecord } from "./lib/types";

const client = new KoderClient();

function App() {
  const [snapshot, setSnapshot] = useState<ClientSnapshot>(client.getSnapshot());
  const [relayUrl, setRelayUrl] = useState(snapshot.connection.relayUrl || "ws://");
  const [pairingCode, setPairingCode] = useState("");
  const [pairingPayloadText, setPairingPayloadText] = useState("");
  const [composerText, setComposerText] = useState("");
  const [actionError, setActionError] = useState("");
  const [activeAction, setActiveAction] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = client.subscribe(setSnapshot);
    return unsubscribe;
  }, []);

  useEffect(() => {
    void client.restoreConnection().catch((error: Error) => {
      setActionError(error.message);
    });
  }, []);

  useEffect(() => {
    if (!relayUrl.trim() && snapshot.connection.relayUrl) {
      setRelayUrl(snapshot.connection.relayUrl);
    }
  }, [relayUrl, snapshot.connection.relayUrl]);

  const activeMessages = useMemo(() => {
    if (!snapshot.activeThreadId) {
      return [];
    }
    return snapshot.messagesByThread[snapshot.activeThreadId] ?? [];
  }, [snapshot.activeThreadId, snapshot.messagesByThread]);

  const visibleError = actionError || snapshot.lastError;
  const isConnected = snapshot.connection.phase === "connected";

  async function runAction(actionLabel: string, action: () => Promise<void>) {
    setActionError("");
    setActiveAction(actionLabel);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setActiveAction(null);
    }
  }

  function handlePairingCodeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runAction("pair-code", async () => {
      await client.connectWithPairingCode(relayUrl, pairingCode);
      setPairingCode("");
    });
  }

  function handlePairingPayloadSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runAction("pair-json", async () => {
      const payload = parsePairingPayload(pairingPayloadText);
      await client.connectWithPairingPayload(payload);
      setPairingPayloadText("");
    });
  }

  function handleQrPairing(rawValue: string) {
    void runAction("pair-qr", async () => {
      const trimmedValue = rawValue.trim();
      if (!trimmedValue) {
        throw new Error("The scanned QR payload was empty.");
      }

      if (trimmedValue.startsWith("{")) {
        const payload = parsePairingPayload(trimmedValue);
        setRelayUrl(payload.relay);
        setPairingCode("");
        setPairingPayloadText(trimmedValue);
        await client.connectWithPairingPayload(payload);
        setPairingPayloadText("");
        return;
      }

      if (!relayUrl.trim()) {
        throw new Error("The scanned QR did not include a relay URL. Enter the relay URL first, then scan again.");
      }

      setPairingPayloadText("");
      setPairingCode(trimmedValue);
      await client.connectWithPairingCode(relayUrl, trimmedValue);
      setPairingCode("");
    });
  }

  function handleSendSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runAction("send", async () => {
      await client.sendMessage(composerText);
      setComposerText("");
    });
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void runAction("send", async () => {
        await client.sendMessage(composerText);
        setComposerText("");
      });
    }
  }

  return (
    <div className="app-shell">
      <div className="app-shell__glow app-shell__glow--one" />
      <div className="app-shell__glow app-shell__glow--two" />

      <header className="topbar">
        <div className="brand">
          <div className="brand__mark">K</div>
          <div>
            <p className="eyebrow">Self-hosted PWA</p>
            <h1>Koder</h1>
          </div>
        </div>

        <div className={`topbar__status topbar__status--${snapshot.connection.phase}`}>
          <span className={`status-dot status-dot--${statusTone(snapshot.connection.phase)}`} />
          <div>
            <strong>{snapshot.connection.label}</strong>
            <span>{connectionSubline(snapshot)}</span>
          </div>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar card">
          <section className="sidebar__section">
            <div className="card__header">
              <div>
                <p className="eyebrow">Connection</p>
                <h2>Relay state</h2>
              </div>
              {isConnected ? (
                <button
                  type="button"
                  className="chip chip--ghost"
                  onClick={() => {
                    void runAction("disconnect", () => client.disconnect({ preservePairing: true }));
                  }}
                >
                  Disconnect
                </button>
              ) : null}
            </div>

            <dl className="detail-list">
              <div>
                <dt>Secure state</dt>
                <dd>{snapshot.connection.secureState}</dd>
              </div>
              <div>
                <dt>Relay</dt>
                <dd>{snapshot.connection.relayUrl || "None yet"}</dd>
              </div>
              <div>
                <dt>Trusted Macs</dt>
                <dd>{snapshot.trustedMacs.length}</dd>
              </div>
            </dl>
          </section>

          <section className="sidebar__section">
            <div className="card__header">
              <div>
                <p className="eyebrow">Threads</p>
                <h2>Session rail</h2>
              </div>
              <button
                type="button"
                className="chip chip--primary"
                disabled={!isConnected || activeAction === "new-thread"}
                onClick={() => {
                  void runAction("new-thread", async () => {
                    const threadId = await client.createThread();
                    await client.openThread(threadId);
                  });
                }}
              >
                New
              </button>
            </div>

            <div className="thread-list">
              {snapshot.threads.length === 0 ? (
                <p className="sidebar__empty">No threads yet. Pair a Mac and start one.</p>
              ) : null}
              {snapshot.threads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className={`thread ${snapshot.activeThreadId === thread.id ? "thread--active" : ""}`}
                  onClick={() => {
                    void runAction(`thread:${thread.id}`, () => client.openThread(thread.id));
                  }}
                >
                  <div className="thread__body">
                    <strong>{thread.title}</strong>
                    <span>{thread.preview || thread.subtitle || thread.cwd || thread.id}</span>
                  </div>
                  <span className="thread__time">{formatRelativeTime(thread.updatedAt)}</span>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <section className="hero card">
          {!isConnected ? (
            <OnboardingPanel
              relayUrl={relayUrl}
              pairingCode={pairingCode}
              pairingPayloadText={pairingPayloadText}
              trustedMacs={snapshot.trustedMacs}
              busyAction={activeAction}
              onRelayUrlChange={setRelayUrl}
              onPairingCodeChange={setPairingCode}
              onPairingPayloadChange={setPairingPayloadText}
              onPairingCodeSubmit={handlePairingCodeSubmit}
              onPairingPayloadSubmit={handlePairingPayloadSubmit}
              onQrScan={handleQrPairing}
              onReconnect={(macDeviceId) => {
                void runAction(`reconnect:${macDeviceId}`, () => client.reconnectToTrustedMac(macDeviceId));
              }}
              onForget={(macDeviceId) => {
                client.forgetReconnectCandidate(macDeviceId);
              }}
            />
          ) : (
            <>
              <div className="hero__header">
                <div>
                  <p className="eyebrow">Workspace</p>
                  <h2>{snapshot.activeThreadId ? activeThreadTitle(snapshot) : "Open or start a thread"}</h2>
                </div>
                <div className="hero__meta">
                  <span className="pill">Self-hosted</span>
                  <button
                    type="button"
                    className="chip chip--ghost"
                    onClick={() => {
                      void runAction("refresh-threads", () => client.refreshThreads());
                    }}
                  >
                    Refresh
                  </button>
                </div>
              </div>

              <div className="message-pane">
                {activeMessages.length === 0 ? (
                  <div className="message-pane__empty">
                    <p>No timeline yet.</p>
                    <span>Send a message to verify the secure transport end to end.</span>
                  </div>
                ) : null}
                {activeMessages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
              </div>

              {snapshot.pendingApprovals.length > 0 ? (
                <section className="approval-stack">
                  <div className="card__header">
                    <div>
                      <p className="eyebrow">Approvals</p>
                      <h2>Bridge requests</h2>
                    </div>
                  </div>
                  {snapshot.pendingApprovals.map((approval) => (
                    <ApprovalCard
                      key={approval.id}
                      approval={approval}
                      busyAction={activeAction}
                      onDecision={(decision) => {
                        void runAction(`approval:${approval.id}:${decision}`, () => (
                          client.respondToApproval(approval.id, decision)
                        ));
                      }}
                    />
                  ))}
                </section>
              ) : null}

              <form className="composer" onSubmit={handleSendSubmit}>
                <div className="composer__chrome">
                  <span className="composer__label">Prompt</span>
                  <span className="composer__hint">Press Cmd/Ctrl+Enter to send</span>
                </div>
                <textarea
                  aria-label="Prompt"
                  placeholder="Ask the Mac to inspect code, run commands, or edit files."
                  value={composerText}
                  onChange={(event) => setComposerText(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                />
                <div className="composer__actions">
                  <button
                    type="button"
                    className="chip chip--ghost"
                    onClick={() => setComposerText("")}
                  >
                    Clear
                  </button>
                  <button
                    type="submit"
                    className="chip chip--primary"
                    disabled={!composerText.trim() || activeAction === "send"}
                  >
                    Send
                  </button>
                </div>
              </form>
            </>
          )}
        </section>

        <aside className="rail">
          <section className="card rail__panel">
            <div className="card__header">
              <div>
                <p className="eyebrow">Health</p>
                <h2>Session state</h2>
              </div>
            </div>

            <div className="stats">
              <div className={`stat stat--${statusTone(snapshot.connection.phase)}`}>
                <span>Connection</span>
                <strong>{snapshot.connection.phase}</strong>
              </div>
              <div className="stat stat--neutral">
                <span>Active thread</span>
                <strong>{snapshot.activeThreadId ? activeThreadTitle(snapshot) : "None"}</strong>
              </div>
              <div className="stat stat--warn">
                <span>Pending approvals</span>
                <strong>{snapshot.pendingApprovals.length}</strong>
              </div>
            </div>
          </section>

          <section className="card rail__panel">
            <div className="card__header">
              <div>
                <p className="eyebrow">Pairing</p>
                <h2>Phone flow</h2>
              </div>
            </div>
            <ul className="bullet-list">
              <li>Run <code>./run-local-koder.sh --hostname &lt;your-mac-ip&gt;</code> on the Mac.</li>
              <li>Scan the printed QR first. If live camera is unavailable on this origin, use the photo fallback or the printed relay URL and pairing code.</li>
              <li>After one successful pair, reconnect comes from the saved trusted Mac record.</li>
            </ul>
          </section>

          {visibleError ? (
            <section className="card rail__panel rail__panel--error">
              <div className="card__header">
                <div>
                  <p className="eyebrow">Last error</p>
                  <h2>Needs attention</h2>
                </div>
                <button
                  type="button"
                  className="chip chip--ghost"
                  onClick={() => setActionError("")}
                >
                  Clear
                </button>
              </div>
              <p className="error-copy">{visibleError}</p>
            </section>
          ) : null}
        </aside>
      </main>
    </div>
  );
}

function OnboardingPanel(props: {
  relayUrl: string;
  pairingCode: string;
  pairingPayloadText: string;
  trustedMacs: TrustedMacRecord[];
  busyAction: string | null;
  onRelayUrlChange: (value: string) => void;
  onPairingCodeChange: (value: string) => void;
  onPairingPayloadChange: (value: string) => void;
  onPairingCodeSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onPairingPayloadSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onQrScan: (value: string) => void;
  onReconnect: (macDeviceId: string) => void;
  onForget: (macDeviceId: string) => void;
}) {
  return (
    <div className="onboarding">
      <div className="hero__header">
        <div>
          <p className="eyebrow">Onboarding</p>
          <h2>Pair this browser with your self-hosted Mac.</h2>
        </div>
        <span className="pill">QR pairing</span>
      </div>

      <p className="hero__lede">
        Use the advertised relay URL and short pairing code printed by `./run-local-koder.sh`.
        The browser stores its own device key locally, then reconnects through the trusted-session flow.
        If you have the laptop terminal open, you can now scan the QR directly from here.
      </p>

      <div className="onboarding__grid">
        <PairingQrScanner
          disabled={props.busyAction === "pair-code" || props.busyAction === "pair-json" || props.busyAction === "pair-qr"}
          onScan={props.onQrScan}
        />

        <form className="setup-card" onSubmit={props.onPairingCodeSubmit}>
          <div className="setup-card__header">
            <p className="eyebrow">Manual</p>
            <h3>Pair with code</h3>
          </div>
          <label className="field">
            <span>Relay URL</span>
            <input
              value={props.relayUrl}
              onChange={(event) => props.onRelayUrlChange(event.target.value)}
              placeholder="ws://192.168.1.10:9000/relay"
            />
          </label>
          <label className="field">
            <span>Pairing code</span>
            <input
              value={props.pairingCode}
              onChange={(event) => props.onPairingCodeChange(event.target.value)}
              placeholder="RMX1:ABC123..."
            />
          </label>
          <button
            type="submit"
            className="chip chip--primary chip--stretch"
            disabled={!props.relayUrl.trim() || !props.pairingCode.trim() || props.busyAction === "pair-code"}
          >
            Connect to Mac
          </button>
        </form>

        <form className="setup-card" onSubmit={props.onPairingPayloadSubmit}>
          <div className="setup-card__header">
            <p className="eyebrow">Fallback</p>
            <h3>Paste QR payload JSON</h3>
          </div>
          <label className="field">
            <span>Pairing payload</span>
            <textarea
              value={props.pairingPayloadText}
              onChange={(event) => props.onPairingPayloadChange(event.target.value)}
              placeholder='{"v":2,"relay":"ws://.../relay","sessionId":"..."}'
            />
          </label>
          <button
            type="submit"
            className="chip chip--ghost chip--stretch"
            disabled={!props.pairingPayloadText.trim() || props.busyAction === "pair-json"}
          >
            Use QR payload
          </button>
        </form>
      </div>

      <section className="trusted-grid">
        <div className="card__header">
          <div>
            <p className="eyebrow">Reconnect</p>
            <h2>Trusted Macs</h2>
          </div>
        </div>

        {props.trustedMacs.length === 0 ? (
          <p className="sidebar__empty">No trusted Macs yet. Complete one pairing first.</p>
        ) : null}

        {props.trustedMacs.map((mac) => (
          <article key={mac.macDeviceId} className="trusted-card">
            <div>
              <strong>{mac.displayName || mac.macDeviceId.slice(0, 8)}</strong>
              <span>{mac.relayURL || "No relay URL saved"}</span>
            </div>
            <div className="trusted-card__actions">
              <button
                type="button"
                className="chip chip--primary"
                disabled={!mac.relayURL || props.busyAction === `reconnect:${mac.macDeviceId}`}
                onClick={() => props.onReconnect(mac.macDeviceId)}
              >
                Reconnect
              </button>
              <button
                type="button"
                className="chip chip--ghost"
                onClick={() => props.onForget(mac.macDeviceId)}
              >
                Forget
              </button>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}

function MessageBubble({ message }: { message: ConversationMessage }) {
  return (
    <article className={`message message--${message.role} message--${message.kind}`}>
      <header className="message__header">
        <span>{messageLabel(message)}</span>
        <span>{formatClockTime(message.createdAt)}</span>
      </header>
      <div className="message__body">
        <pre>{message.text || (message.isStreaming ? "…" : "")}</pre>
      </div>
      {message.role === "user" ? (
        <footer className={`message__footer message__footer--${message.deliveryState}`}>
          {message.deliveryState}
        </footer>
      ) : null}
    </article>
  );
}

function ApprovalCard(props: {
  approval: ApprovalRequest;
  busyAction: string | null;
  onDecision: (decision: "accept" | "reject") => void;
}) {
  return (
    <article className="approval-card">
      <div className="approval-card__copy">
        <strong>{props.approval.method}</strong>
        <p>{props.approval.reason || props.approval.command || "Bridge approval required."}</p>
      </div>
      <div className="approval-card__actions">
        <button
          type="button"
          className="chip chip--ghost"
          disabled={Boolean(props.busyAction?.startsWith(`approval:${props.approval.id}:`))}
          onClick={() => props.onDecision("reject")}
        >
          Deny
        </button>
        <button
          type="button"
          className="chip chip--primary"
          disabled={Boolean(props.busyAction?.startsWith(`approval:${props.approval.id}:`))}
          onClick={() => props.onDecision("accept")}
        >
          Accept
        </button>
      </div>
    </article>
  );
}

function activeThreadTitle(snapshot: ClientSnapshot): string {
  return snapshot.threads.find((thread) => thread.id === snapshot.activeThreadId)?.title ?? "Thread";
}

function connectionSubline(snapshot: ClientSnapshot): string {
  if (snapshot.connection.macName) {
    return `${snapshot.connection.macName} · ${snapshot.connection.relayUrl || "no relay saved"}`;
  }
  return snapshot.connection.relayUrl || "No relay paired yet";
}

function statusTone(phase: ClientSnapshot["connection"]["phase"]): "good" | "warn" | "neutral" | "bad" {
  switch (phase) {
    case "connected":
      return "good";
    case "connecting":
    case "restoring":
      return "warn";
    case "error":
      return "bad";
    default:
      return "neutral";
  }
}

function messageLabel(message: ConversationMessage): string {
  if (message.role === "assistant" && message.isStreaming) {
    return "Assistant · streaming";
  }
  return `${message.role} · ${message.kind}`;
}

function formatRelativeTime(value: string | null): string {
  if (!value) {
    return "";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const deltaMinutes = Math.round((Date.now() - timestamp) / 60_000);
  if (deltaMinutes < 1) {
    return "now";
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`;
  }
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h`;
  }
  return `${Math.round(deltaHours / 24)}d`;
}

function formatClockTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export default App;
