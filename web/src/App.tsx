import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { PairingQrScanner } from "./components/PairingQrScanner";
import { KoderClient } from "./lib/client";
import {
  canUseSystemNotifications,
  isStandaloneDisplayMode,
  readNotificationPermissionState,
  requestNotificationPermissionFromUser,
  showSystemNotification,
  syncAppBadge,
  type NotificationPermissionState,
} from "./lib/pwa";
import { parsePairingPayload } from "./lib/protocol";
import type {
  ApprovalRequest,
  ClientSnapshot,
  ConversationMessage,
  ThreadSummary,
  TrustedMacRecord,
} from "./lib/types";

const client = new KoderClient();
const COMPACT_LAYOUT_QUERY = "(max-width: 920px)";

type MobilePane = "sessions" | "chat" | "status";

function App() {
  const [snapshot, setSnapshot] = useState<ClientSnapshot>(client.getSnapshot());
  const [relayUrl, setRelayUrl] = useState(snapshot.connection.relayUrl || preferredRelayUrlFromPage() || "ws://");
  const [pairingCode, setPairingCode] = useState("");
  const [pairingPayloadText, setPairingPayloadText] = useState("");
  const [composerText, setComposerText] = useState("");
  const [actionError, setActionError] = useState("");
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>("sessions");
  const [isCompactLayout, setIsCompactLayout] = useState(readCompactLayout);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>(
    readNotificationPermissionState
  );
  const [isStandaloneMode, setIsStandaloneMode] = useState(isStandaloneDisplayMode);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const seenApprovalIdsRef = useRef<Set<string>>(new Set());
  const alertsHydratedRef = useRef(false);

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

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const media = window.matchMedia(COMPACT_LAYOUT_QUERY);
    const updateLayout = () => {
      setIsCompactLayout(media.matches);
    };

    updateLayout();
    media.addEventListener("change", updateLayout);
    return () => {
      media.removeEventListener("change", updateLayout);
    };
  }, []);

  useEffect(() => {
    const updatePwaState = () => {
      setNotificationPermission(readNotificationPermissionState());
      setIsStandaloneMode(isStandaloneDisplayMode());
    };

    updatePwaState();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", updatePwaState);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", updatePwaState);
    }

    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", updatePwaState);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", updatePwaState);
      }
    };
  }, []);

  useEffect(() => {
    if (isCompactLayout && snapshot.activeThreadId) {
      setMobilePane("chat");
    }
  }, [isCompactLayout, snapshot.activeThreadId]);

  const activeThread = useMemo(() => {
    if (!snapshot.activeThreadId) {
      return null;
    }
    return snapshot.threads.find((thread) => thread.id === snapshot.activeThreadId) ?? null;
  }, [snapshot.activeThreadId, snapshot.threads]);

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
        const resolvedRelayUrl = preferredRelayUrlFromPage() || payload.relay;
        const securePayload = {
          ...payload,
          relay: resolvedRelayUrl,
        };
        setRelayUrl(resolvedRelayUrl);
        setPairingCode("");
        setPairingPayloadText(JSON.stringify(securePayload));
        await client.connectWithPairingPayload(securePayload);
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

  function handleOpenThread(threadId: string) {
    void runAction(`thread:${threadId}`, () => client.openThread(threadId));
    if (isCompactLayout) {
      setMobilePane("chat");
    }
  }

  function handleCreateThread() {
    void runAction("new-thread", async () => {
      const threadId = await client.createThread();
      await client.openThread(threadId);
    });
    if (isCompactLayout) {
      setMobilePane("chat");
    }
  }

  useEffect(() => {
    const assistantMessages = Object.values(snapshot.messagesByThread)
      .flat()
      .filter((message) => (
        message.role === "assistant"
        && message.deliveryState === "confirmed"
        && !message.isStreaming
      ));
    const currentApprovalIds = new Set(snapshot.pendingApprovals.map((approval) => approval.id));

    if (!alertsHydratedRef.current) {
      seenMessageIdsRef.current = new Set(assistantMessages.map((message) => message.id));
      seenApprovalIdsRef.current = currentApprovalIds;
      alertsHydratedRef.current = true;
      return;
    }

    void syncAppBadge(snapshot.pendingApprovals.length).catch(() => {});

    if (!shouldSurfaceSystemAlert() || notificationPermission !== "granted") {
      seenMessageIdsRef.current = new Set(assistantMessages.map((message) => message.id));
      seenApprovalIdsRef.current = currentApprovalIds;
      return;
    }

    for (const message of assistantMessages) {
      if (seenMessageIdsRef.current.has(message.id) || !isFreshEnoughForAlert(message.createdAt)) {
        continue;
      }
      seenMessageIdsRef.current.add(message.id);
      const threadTitle = snapshot.threads.find((thread) => thread.id === message.threadId)?.title || "Koder";
      void showSystemNotification({
        title: `Koder · ${threadTitle}`,
        body: clampNotificationBody(message.text),
        tag: `thread:${message.threadId}`,
        url: "/",
      }).catch(() => {});
    }

    for (const approval of snapshot.pendingApprovals) {
      if (seenApprovalIdsRef.current.has(approval.id)) {
        continue;
      }
      seenApprovalIdsRef.current.add(approval.id);
      void showSystemNotification({
        title: "Koder approval needed",
        body: clampNotificationBody(approval.reason || approval.command || approval.method),
        tag: `approval:${approval.id}`,
        url: "/",
      }).catch(() => {});
    }

    seenApprovalIdsRef.current = currentApprovalIds;
  }, [notificationPermission, snapshot.messagesByThread, snapshot.pendingApprovals, snapshot.threads]);

  function handleEnableAlerts() {
    void runAction("enable-alerts", async () => {
      const permission = await requestNotificationPermissionFromUser();
      setNotificationPermission(permission);
      if (permission !== "granted") {
        throw new Error(permission === "denied"
          ? "Notifications are blocked for this browser session."
          : "Notification permission was not granted.");
      }
      await showSystemNotification({
        title: "Koder alerts enabled",
        body: "You will now receive local assistant and approval notifications while this PWA stays connected.",
        tag: "alerts-enabled",
        url: "/",
        silent: true,
      });
    });
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

      {isConnected && isCompactLayout ? (
        <nav className="mobile-workspace-nav" aria-label="Workspace sections">
          <button
            type="button"
            className={`mobile-workspace-nav__item ${mobilePane === "sessions" ? "mobile-workspace-nav__item--active" : ""}`}
            onClick={() => setMobilePane("sessions")}
          >
            <span>Sessions</span>
            <strong>{snapshot.threads.length}</strong>
          </button>
          <button
            type="button"
            className={`mobile-workspace-nav__item ${mobilePane === "chat" ? "mobile-workspace-nav__item--active" : ""}`}
            onClick={() => setMobilePane("chat")}
          >
            <span>Chat</span>
            <strong>{activeThread ? "live" : "pick"}</strong>
          </button>
          <button
            type="button"
            className={`mobile-workspace-nav__item ${mobilePane === "status" ? "mobile-workspace-nav__item--active" : ""}`}
            onClick={() => setMobilePane("status")}
          >
            <span>Status</span>
            <strong>{snapshot.pendingApprovals.length || visibleError ? "!" : "ok"}</strong>
          </button>
        </nav>
      ) : null}

      <main
        className={[
          "workspace",
          isConnected ? "workspace--connected" : "workspace--onboarding",
          isCompactLayout ? `workspace--pane-${mobilePane}` : "",
        ].join(" ")}
      >
        {isConnected ? (
          <>
            <aside className="sidebar card">
              <SessionRail
                connection={snapshot.connection}
                threads={snapshot.threads}
                trustedMacCount={snapshot.trustedMacs.length}
                activeThreadId={snapshot.activeThreadId}
                activeAction={activeAction}
                onCreateThread={handleCreateThread}
                onOpenThread={handleOpenThread}
                onDisconnect={() => {
                  void runAction("disconnect", () => client.disconnect({ preservePairing: true }));
                }}
              />
            </aside>

            <section className="hero card">
              <ChatStage
                activeThread={activeThread}
                activeMessages={activeMessages}
                composerText={composerText}
                activeAction={activeAction}
                pendingApprovals={snapshot.pendingApprovals}
                isCompactLayout={isCompactLayout}
                onBackToSessions={() => setMobilePane("sessions")}
                onComposerChange={setComposerText}
                onComposerKeyDown={handleComposerKeyDown}
                onRefresh={() => {
                  void runAction("refresh-threads", () => client.refreshThreads());
                }}
                onSendSubmit={handleSendSubmit}
                onDecision={(approvalId, decision) => {
                  void runAction(`approval:${approvalId}:${decision}`, () => (
                    client.respondToApproval(approvalId, decision)
                  ));
                }}
              />
            </section>

            <aside className="rail card">
              <StatusRail
                snapshot={snapshot}
                visibleError={visibleError}
                notificationPermission={notificationPermission}
                canUseNotifications={canUseSystemNotifications()}
                isStandaloneMode={isStandaloneMode}
                activeAction={activeAction}
                onEnableAlerts={handleEnableAlerts}
                onClearError={() => setActionError("")}
              />
            </aside>
          </>
        ) : (
          <>
            <section className="hero card hero--onboarding">
              <OnboardingPanel
                connection={snapshot.connection}
                visibleError={visibleError}
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
                onRetrySavedPair={() => {
                  void runAction("restore", () => client.restoreConnection());
                }}
                onForgetCurrentPair={() => {
                  client.forgetReconnectCandidate(snapshot.connection.macDeviceId || undefined);
                  setPairingCode("");
                  setPairingPayloadText("");
                  setActionError("Saved pairing removed. Scan a fresh QR or enter a new pairing code.");
                }}
                onReconnect={(macDeviceId) => {
                  void runAction(`reconnect:${macDeviceId}`, () => client.reconnectToTrustedMac(macDeviceId));
                }}
                onForget={(macDeviceId) => {
                  client.forgetReconnectCandidate(macDeviceId);
                }}
              />
            </section>

            <aside className="rail card rail--support">
              <StatusRail
                snapshot={snapshot}
                visibleError={visibleError}
                notificationPermission={notificationPermission}
                canUseNotifications={canUseSystemNotifications()}
                isStandaloneMode={isStandaloneMode}
                activeAction={activeAction}
                onEnableAlerts={handleEnableAlerts}
                onClearError={() => setActionError("")}
              />
            </aside>
          </>
        )}
      </main>
    </div>
  );
}

function SessionRail(props: {
  connection: ClientSnapshot["connection"];
  threads: ThreadSummary[];
  trustedMacCount: number;
  activeThreadId: string | null;
  activeAction: string | null;
  onCreateThread: () => void;
  onOpenThread: (threadId: string) => void;
  onDisconnect: () => void;
}) {
  return (
    <>
      <section className="sidebar__section sidebar__section--connection">
        <div className="card__header">
          <div>
            <p className="eyebrow">Connection</p>
            <h2>Live bridge</h2>
          </div>
          <button type="button" className="chip chip--ghost" onClick={props.onDisconnect}>
            Disconnect
          </button>
        </div>

        <div className="connection-grid">
          <article className="connection-tile">
            <span>State</span>
            <strong>{props.connection.secureState}</strong>
          </article>
          <article className="connection-tile">
            <span>Mac</span>
            <strong>{props.connection.macName || "Unknown"}</strong>
          </article>
          <article className="connection-tile">
            <span>Trusted</span>
            <strong>{props.trustedMacCount}</strong>
          </article>
        </div>
      </section>

      <section className="sidebar__section sidebar__section--threads">
        <div className="card__header">
          <div>
            <p className="eyebrow">Sessions</p>
            <h2>Thread rail</h2>
          </div>
          <button
            type="button"
            className="chip chip--primary"
            disabled={props.activeAction === "new-thread"}
            onClick={props.onCreateThread}
          >
            New
          </button>
        </div>

        <div className="thread-list">
          {props.threads.length === 0 ? (
            <p className="sidebar__empty">No sessions yet. Start one and it will appear here.</p>
          ) : null}
          {props.threads.map((thread) => (
            <ThreadListItem
              key={thread.id}
              thread={thread}
              active={props.activeThreadId === thread.id}
              onOpen={() => props.onOpenThread(thread.id)}
            />
          ))}
        </div>
      </section>
    </>
  );
}

function ThreadListItem(props: { thread: ThreadSummary; active: boolean; onOpen: () => void }) {
  const descriptor = threadDescriptor(props.thread);
  const preview = threadPreview(props.thread);

  return (
    <button
      type="button"
      className={`thread ${props.active ? "thread--active" : ""}`}
      onClick={props.onOpen}
    >
      <div className="thread__meta">
        <span className="thread__badge">{descriptor}</span>
        <span className="thread__time">{formatRelativeTime(props.thread.updatedAt)}</span>
      </div>
      <div className="thread__body">
        <strong>{props.thread.title}</strong>
        <p className="thread__preview">{preview}</p>
      </div>
    </button>
  );
}

function ChatStage(props: {
  activeThread: ThreadSummary | null;
  activeMessages: ConversationMessage[];
  composerText: string;
  activeAction: string | null;
  pendingApprovals: ApprovalRequest[];
  isCompactLayout: boolean;
  onBackToSessions: () => void;
  onComposerChange: (value: string) => void;
  onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onRefresh: () => void;
  onSendSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDecision: (approvalId: string, decision: "accept" | "reject") => void;
}) {
  const hasThread = Boolean(props.activeThread);
  const messagePaneRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const pane = messagePaneRef.current;
    if (!pane || !props.activeThread) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      pane.scrollTop = pane.scrollHeight;
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [props.activeThread, props.activeMessages.length]);

  return (
    <div className="chat-stage">
      <div className="chat-stage__header">
        <div className="chat-stage__title">
          {props.isCompactLayout ? (
            <button type="button" className="chat-stage__back" onClick={props.onBackToSessions}>
              Sessions
            </button>
          ) : null}
          <div>
            <p className="eyebrow">Conversation</p>
            <h2>{props.activeThread?.title || "Choose a session to focus the chat"}</h2>
            <p className="chat-stage__subtitle">
              {props.activeThread ? threadPreview(props.activeThread) : "The phone view now keeps one conversation in focus instead of dumping the whole workspace on screen."}
            </p>
          </div>
        </div>

        <div className="chat-stage__toolbar">
          {props.pendingApprovals.length > 0 ? (
            <span className="pill pill--warn">{props.pendingApprovals.length} approvals</span>
          ) : null}
          <button type="button" className="chip chip--ghost" onClick={props.onRefresh}>
            Refresh
          </button>
        </div>
      </div>

      <div className="message-pane" ref={messagePaneRef}>
        {!hasThread ? (
          <div className="message-pane__empty">
            <p>No session selected.</p>
            <span>Open a session from the rail and the transcript will stay inside this scrollable pane.</span>
          </div>
        ) : null}

        {props.activeMessages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>

      {props.pendingApprovals.length > 0 ? (
        <section className="approval-stack">
          {props.pendingApprovals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              busyAction={props.activeAction}
              onDecision={(decision) => props.onDecision(approval.id, decision)}
            />
          ))}
        </section>
      ) : null}

      <form className="composer" onSubmit={props.onSendSubmit}>
        <div className="composer__chrome">
          <span className="composer__label">Prompt</span>
          <span className="composer__hint">Cmd/Ctrl+Enter sends instantly</span>
        </div>
        <textarea
          aria-label="Prompt"
          placeholder="Ask the Mac to inspect code, run commands, or edit files."
          value={props.composerText}
          onChange={(event) => props.onComposerChange(event.target.value)}
          onKeyDown={props.onComposerKeyDown}
        />
        <div className="composer__actions">
          <button
            type="button"
            className="chip chip--ghost"
            onClick={() => props.onComposerChange("")}
          >
            Clear
          </button>
          <button
            type="submit"
            className="chip chip--primary"
            disabled={!props.composerText.trim() || props.activeAction === "send" || !hasThread}
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

function StatusRail(props: {
  snapshot: ClientSnapshot;
  visibleError: string;
  notificationPermission: NotificationPermissionState;
  canUseNotifications: boolean;
  isStandaloneMode: boolean;
  activeAction: string | null;
  onEnableAlerts: () => void;
  onClearError: () => void;
}) {
  return (
    <>
      <section className="rail__panel rail__panel--stats">
        <div className="card__header">
          <div>
            <p className="eyebrow">Health</p>
            <h2>Session state</h2>
          </div>
        </div>

        <div className="stats">
          <div className={`stat stat--${statusTone(props.snapshot.connection.phase)}`}>
            <span>Connection</span>
            <strong>{props.snapshot.connection.phase}</strong>
          </div>
          <div className="stat stat--neutral">
            <span>Active</span>
            <strong>{props.snapshot.activeThreadId ? activeThreadTitle(props.snapshot) : "None"}</strong>
          </div>
          <div className="stat stat--warn">
            <span>Approvals</span>
            <strong>{props.snapshot.pendingApprovals.length}</strong>
          </div>
        </div>
      </section>

      <section className="rail__panel">
        <div className="card__header">
          <div>
            <p className="eyebrow">PWA</p>
            <h2>Install and alerts</h2>
          </div>
        </div>
        <div className="connection-grid connection-grid--stacked">
          <article className="connection-tile">
            <span>Mode</span>
            <strong>{props.isStandaloneMode ? "Installed app" : "Browser tab"}</strong>
          </article>
          <article className="connection-tile">
            <span>Alerts</span>
            <strong>{notificationStatusLabel(props.notificationPermission, props.canUseNotifications)}</strong>
          </article>
        </div>
        <p className="rail__hint">
          Installed Home Screen mode is what unlocks iPhone web-push later. Right now the PWA can already raise local system alerts while a live session is connected.
        </p>
        {props.canUseNotifications && props.notificationPermission !== "granted" ? (
          <button
            type="button"
            className="chip chip--primary"
            disabled={props.activeAction === "enable-alerts"}
            onClick={props.onEnableAlerts}
          >
            Enable alerts
          </button>
        ) : null}
      </section>

      <section className="rail__panel">
        <div className="card__header">
          <div>
            <p className="eyebrow">Pairing</p>
            <h2>Phone flow</h2>
          </div>
        </div>
        <ul className="bullet-list">
          <li>Run <code>./run-local-koder.sh --hostname &lt;your-mac-ip&gt;</code> on the Mac.</li>
          <li>Scan the QR first. Koder now rewrites that pairing onto the secure relay origin used by the page.</li>
          <li>Reconnect later from the saved trusted Mac card instead of pairing again.</li>
        </ul>
      </section>

      {props.visibleError ? (
        <section className="rail__panel rail__panel--error">
          <div className="card__header">
            <div>
              <p className="eyebrow">Last error</p>
              <h2>Needs attention</h2>
            </div>
            <button type="button" className="chip chip--ghost" onClick={props.onClearError}>
              Clear
            </button>
          </div>
          <p className="error-copy">{props.visibleError}</p>
        </section>
      ) : null}
    </>
  );
}

function OnboardingPanel(props: {
  connection: ClientSnapshot["connection"];
  visibleError: string;
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
  onRetrySavedPair: () => void;
  onForgetCurrentPair: () => void;
  onReconnect: (macDeviceId: string) => void;
  onForget: (macDeviceId: string) => void;
}) {
  const scannerSectionRef = useRef<HTMLDivElement | null>(null);
  const hasRecoveryState = Boolean(
    props.connection.macDeviceId
      || props.trustedMacs.length
      || props.connection.phase === "connecting"
      || props.connection.phase === "restoring"
      || props.connection.phase === "error"
      || props.visibleError
  );

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
        Use the advertised relay URL and short pairing code printed by <code>./run-local-koder.sh</code>.
        The browser stores its own device key locally, then reconnects through the trusted-session flow.
      </p>

      {hasRecoveryState ? (
        <section className="recovery-card">
          <div className="recovery-card__header">
            <div>
              <p className="eyebrow">Recovery</p>
              <h3>{recoveryTitle(props.connection)}</h3>
            </div>
            <span className={`pill ${props.connection.phase === "error" ? "pill--warn" : ""}`}>
              {props.connection.phase}
            </span>
          </div>

          <p className="recovery-card__copy">
            {props.visibleError
              || recoveryCopy(props.connection)}
          </p>

          <div className="recovery-card__meta">
            <article className="connection-tile">
              <span>Saved Mac</span>
              <strong>{props.connection.macName || props.connection.macDeviceId || "Unknown"}</strong>
            </article>
            <article className="connection-tile">
              <span>Relay</span>
              <strong>{compactRelayLabel(props.connection.relayUrl) || "No relay saved"}</strong>
            </article>
          </div>

          <div className="recovery-card__actions">
            <button
              type="button"
              className="chip chip--primary"
              disabled={props.busyAction === "restore"}
              onClick={props.onRetrySavedPair}
            >
              Try reconnect
            </button>
            <button
              type="button"
              className="chip chip--ghost"
              onClick={() => scannerSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              Scan QR again
            </button>
            <button
              type="button"
              className="chip chip--ghost chip--danger"
              onClick={props.onForgetCurrentPair}
            >
              Forget saved pair
            </button>
          </div>
        </section>
      ) : null}

      <div className="onboarding__grid">
        <div ref={scannerSectionRef}>
          <PairingQrScanner
            disabled={props.busyAction === "pair-code" || props.busyAction === "pair-json" || props.busyAction === "pair-qr"}
            onScan={props.onQrScan}
          />
        </div>

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
              placeholder="wss://192.168.1.10:5173/relay"
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
              placeholder='{"v":2,"relay":"wss://.../relay","sessionId":"..."}'
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
  const relayHost = compactRelayLabel(snapshot.connection.relayUrl);
  if (snapshot.connection.macName && relayHost) {
    return `${snapshot.connection.macName} · ${relayHost}`;
  }
  return snapshot.connection.macName || relayHost || "No relay paired yet";
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

function recoveryTitle(connection: ClientSnapshot["connection"]): string {
  if (connection.phase === "error") {
    return "This saved pair needs intervention.";
  }
  if (connection.phase === "connecting" || connection.phase === "restoring") {
    return "Trusted reconnect is taking too long.";
  }
  if (connection.secureState === "trustedMac") {
    return "A saved trusted Mac is ready.";
  }
  return "Use a fresh pairing if reconnect is unreliable.";
}

function recoveryCopy(connection: ClientSnapshot["connection"]): string {
  if (connection.phase === "error") {
    return "The saved trust record failed. Reconnect once if you expect a transient network issue, otherwise forget it and scan a fresh QR.";
  }
  if (connection.phase === "connecting" || connection.phase === "restoring") {
    return "The browser should not sit here indefinitely anymore. If this reconnect still hangs, skip the old trust record and pair from a fresh QR now.";
  }
  return "Saved trusted-Mac reconnect is meant to be convenient, not mandatory. A fresh QR pairing should always be one tap away.";
}

function preferredRelayUrlFromPage(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  if (!host) {
    return "";
  }

  return `${protocol}//${host}/relay`;
}

function messageLabel(message: ConversationMessage): string {
  if (message.role === "assistant" && message.isStreaming) {
    return "Assistant · streaming";
  }

  const role = message.role.charAt(0).toUpperCase() + message.role.slice(1);
  const kind = message.kind.replace(/([A-Z])/g, " $1").toLowerCase();
  return `${role} · ${kind}`;
}

function threadDescriptor(thread: ThreadSummary): string {
  return thread.agentNickname || thread.agentRole || (thread.cwd ? "workspace" : "session");
}

function threadPreview(thread: ThreadSummary): string {
  return thread.preview || thread.subtitle || thread.cwd || "Open this session to continue the conversation.";
}

function compactRelayLabel(relayUrl: string): string {
  if (!relayUrl) {
    return "";
  }

  try {
    const url = new URL(relayUrl);
    return url.host;
  } catch {
    return relayUrl;
  }
}

function readCompactLayout(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(COMPACT_LAYOUT_QUERY).matches;
}

function notificationStatusLabel(
  permission: NotificationPermissionState,
  supported: boolean
): string {
  if (!supported || permission === "unsupported") {
    return "Unsupported";
  }
  if (permission === "granted") {
    return "Ready";
  }
  if (permission === "denied") {
    return "Blocked";
  }
  return "Not enabled";
}

function shouldSurfaceSystemAlert(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return document.visibilityState !== "visible" || (typeof document.hasFocus === "function" && !document.hasFocus());
}

function isFreshEnoughForAlert(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && Date.now() - timestamp <= 5 * 60_000;
}

function clampNotificationBody(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 160) {
    return normalized;
  }
  return `${normalized.slice(0, 157)}...`;
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
