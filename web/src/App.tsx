import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
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
import type {
  ApprovalRequest,
  ClientSnapshot,
  ConversationMessage,
  ThreadSummary,
} from "./lib/types";

const client = new KoderClient();
const COMPACT_LAYOUT_QUERY = "(max-width: 920px)";
const COMPACT_MESSAGE_WINDOW = 10;
const COMPACT_MESSAGE_PAGE = 10;
const DESKTOP_MESSAGE_WINDOW = 18;
const DESKTOP_MESSAGE_PAGE = 18;
const COMPACT_THREAD_WINDOW = 18;
const DESKTOP_THREAD_WINDOW = 24;

type MobilePane = "sessions" | "chat" | "status";
function App() {
  const [snapshot, setSnapshot] = useState<ClientSnapshot>(client.getSnapshot());
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
  const isCompactChatPane = isConnected && isCompactLayout && mobilePane === "chat";
  const showTopbarStatus = (isConnected || !isCompactLayout) && !isCompactChatPane;

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
    void runAction(`thread:${threadId}`, async () => {
      await client.openThread(threadId);
      if (isCompactLayout) {
        setMobilePane("chat");
      }
    });
  }

  function handleCreateThread() {
    void runAction("new-thread", async () => {
      const threadId = await client.createThread();
      await client.openThread(threadId);
      if (isCompactLayout) {
        setMobilePane("chat");
      }
    });
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
    <div
      className={[
        "app-shell",
        isConnected ? "app-shell--connected" : "",
        isConnected && isCompactLayout ? "app-shell--compact-connected" : "",
      ].join(" ")}
    >
      <div className="app-shell__glow app-shell__glow--one" />
      <div className="app-shell__glow app-shell__glow--two" />

      <header className={`topbar ${isCompactChatPane ? "topbar--compact-chat" : ""}`}>
        <div className={`brand ${isCompactChatPane ? "brand--compact-chat" : ""}`}>
          <div className="brand__mark">K</div>
          {isCompactChatPane ? (
            <div className="brand__compact-chat-row">
              <button type="button" className="topbar__sessions" onClick={() => setMobilePane("sessions")}>
                Sessions
              </button>
              <h1>{activeThread?.title || "Chat"}</h1>
            </div>
          ) : (
            <div>
              <p className="eyebrow">Self-hosted PWA</p>
              <h1>Koder</h1>
            </div>
          )}
        </div>

        {showTopbarStatus ? (
          <div className={`topbar__status topbar__status--${snapshot.connection.phase}`}>
            <span className={`status-dot status-dot--${statusTone(snapshot.connection.phase)}`} />
            <div>
              <strong>{snapshot.connection.label}</strong>
              <span>{connectionSubline(snapshot)}</span>
            </div>
          </div>
        ) : null}
      </header>

      {isConnected && isCompactLayout && !isCompactChatPane ? (
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
          isConnected && isCompactLayout ? `workspace--pane-${mobilePane}` : "",
        ].join(" ")}
      >
        {isConnected ? (
          <>
            <aside className={`sidebar ${isCompactLayout ? "sidebar--flat" : "card"}`}>
              <SessionRail
                connection={snapshot.connection}
                threads={snapshot.threads}
                threadListHasMore={snapshot.threadListHasMore}
                trustedMacCount={snapshot.trustedMacs.length}
                activeThreadId={snapshot.activeThreadId}
                activeAction={activeAction}
                isCompactLayout={isCompactLayout}
                onCreateThread={handleCreateThread}
                onLoadMoreThreads={() => {
                  void runAction("threads:more", () => client.loadMoreThreads());
                }}
                onOpenThread={handleOpenThread}
                onDisconnect={() => {
                  void runAction("disconnect", () => client.disconnect({ preservePairing: true }));
                }}
              />
            </aside>

            <section className={`hero ${isCompactLayout ? "hero--flat" : "card"}`}>
              <ChatStage
                activeThread={activeThread}
                activeMessages={activeMessages}
                composerText={composerText}
                activeAction={activeAction}
                pendingApprovals={snapshot.pendingApprovals}
                isCompactLayout={isCompactLayout}
                isThreadLoading={snapshot.loadingThreadId === snapshot.activeThreadId}
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

            <aside className={`rail ${isCompactLayout ? "rail--flat" : "card"}`}>
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
            <section className={`hero card hero--onboarding ${isCompactLayout ? "hero--onboarding-compact" : ""}`}>
              <DirectConnectPanel
                connection={snapshot.connection}
                visibleError={visibleError}
                trustedMacs={snapshot.trustedMacs}
                busyAction={activeAction}
                isCompactLayout={isCompactLayout}
                onConnect={() => {
                  const relayUrl = preferredRelayUrlFromPage();
                  if (!relayUrl) {
                    setActionError("This page does not expose a local relay host.");
                    return;
                  }
                  void runAction("connect-local", () => client.connectToSelfHostedHost(relayUrl));
                }}
                onRetrySavedHost={() => {
                  void runAction("restore", () => client.restoreConnection());
                }}
                onForgetCurrentHost={() => {
                  client.forgetReconnectCandidate(snapshot.connection.macDeviceId || undefined);
                  setActionError("Saved host removed. Reconnect directly to this self-hosted Koder instance.");
                }}
              />
            </section>

            {!isCompactLayout ? (
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
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

function SessionRail(props: {
  connection: ClientSnapshot["connection"];
  threads: ThreadSummary[];
  threadListHasMore: boolean;
  trustedMacCount: number;
  activeThreadId: string | null;
  activeAction: string | null;
  isCompactLayout: boolean;
  onCreateThread: () => void;
  onLoadMoreThreads: () => void;
  onOpenThread: (threadId: string) => void;
  onDisconnect: () => void;
}) {
  const visibleThreadWindow = props.isCompactLayout ? COMPACT_THREAD_WINDOW : DESKTOP_THREAD_WINDOW;
  const [visibleThreadCount, setVisibleThreadCount] = useState(visibleThreadWindow);

  useEffect(() => {
    const minimumVisible = props.threads.length === 0
      ? visibleThreadWindow
      : Math.min(visibleThreadWindow, props.threads.length);
    setVisibleThreadCount((current) => {
      if (current < minimumVisible) {
        return minimumVisible;
      }
      if (current > props.threads.length && props.threads.length > 0) {
        return props.threads.length;
      }
      return current;
    });
  }, [props.threads.length, visibleThreadWindow]);

  const visibleThreads = props.threads.slice(0, visibleThreadCount);
  const threadGroups = useMemo(() => buildThreadProjectGroups(visibleThreads), [visibleThreads]);
  const hiddenLoadedThreads = Math.max(0, props.threads.length - visibleThreadCount);

  function handleLoadOlderThreads() {
    if (hiddenLoadedThreads > 0) {
      setVisibleThreadCount((current) => Math.min(props.threads.length, current + visibleThreadWindow));
      return;
    }
    props.onLoadMoreThreads();
  }

  const loadOlderLabel = hiddenLoadedThreads > 0
    ? `Show ${Math.min(hiddenLoadedThreads, visibleThreadWindow)} more recent sessions`
    : (props.threadListHasMore ? "Load older sessions" : "");

  return (
    <>
      {!props.isCompactLayout ? (
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
      ) : null}

      <section className={`sidebar__section sidebar__section--threads ${props.isCompactLayout ? "sidebar__section--flat" : ""}`}>
        <div className="card__header">
          <div>
            <p className="eyebrow">Sessions</p>
            <h2>{props.isCompactLayout ? "Recent sessions" : "Thread rail"}</h2>
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
          {threadGroups.map((group) => (
            <section key={group.key} className={`thread-group ${props.isCompactLayout ? "thread-group--compact" : ""}`}>
              <header className="thread-group__header">
                <div className="thread-group__copy">
                  <strong>{group.label}</strong>
                  <span>{group.pathLabel}</span>
                </div>
                <span className="thread-group__count">{group.threads.length}</span>
              </header>

              <div className="thread-group__list">
                {group.threads.map((thread) => (
                  <ThreadListItem
                    key={thread.id}
                    thread={thread}
                    active={props.activeThreadId === thread.id}
                    compact={props.isCompactLayout}
                    onOpen={() => props.onOpenThread(thread.id)}
                  />
                ))}
              </div>
            </section>
          ))}
          {loadOlderLabel ? (
            <button
              type="button"
              className="thread-list__footer chip chip--ghost"
              disabled={props.activeAction === "threads:more"}
              onClick={handleLoadOlderThreads}
            >
              {loadOlderLabel}
            </button>
          ) : null}
        </div>
      </section>
    </>
  );
}

function ThreadListItem(props: { thread: ThreadSummary; active: boolean; compact?: boolean; onOpen: () => void }) {
  const descriptor = threadDescriptor(props.thread);
  const preview = threadPreview(props.thread);

  return (
    <button
      type="button"
      className={`thread ${props.compact ? "thread--compact" : ""} ${props.active ? "thread--active" : ""}`}
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
  isThreadLoading: boolean;
  onBackToSessions: () => void;
  onComposerChange: (value: string) => void;
  onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onRefresh: () => void;
  onSendSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDecision: (approvalId: string, decision: "accept" | "reject") => void;
}) {
  const hasThread = Boolean(props.activeThread);
  const messagePaneRef = useRef<HTMLDivElement | null>(null);
  const scrollRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const initialVisibleMessageCount = props.isCompactLayout ? COMPACT_MESSAGE_WINDOW : DESKTOP_MESSAGE_WINDOW;
  const messagePageSize = props.isCompactLayout ? COMPACT_MESSAGE_PAGE : DESKTOP_MESSAGE_PAGE;
  const activeThreadId = props.activeThread?.id ?? null;
  const [visibleMessageCount, setVisibleMessageCount] = useState(initialVisibleMessageCount);
  const hiddenMessageCount = Math.max(0, props.activeMessages.length - visibleMessageCount);
  const visibleMessages = hiddenMessageCount > 0
    ? props.activeMessages.slice(-visibleMessageCount)
    : props.activeMessages;
  const latestVisibleMessageId = visibleMessages.at(-1)?.id ?? "";

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    setVisibleMessageCount(activeThreadId ? Math.min(initialVisibleMessageCount, props.activeMessages.length) : initialVisibleMessageCount);
  }, [activeThreadId, initialVisibleMessageCount]);

  useEffect(() => {
    if (!activeThreadId) {
      return;
    }
    const minimumVisible = Math.min(initialVisibleMessageCount, props.activeMessages.length);
    setVisibleMessageCount((current) => current < minimumVisible ? minimumVisible : current);
  }, [activeThreadId, initialVisibleMessageCount, props.activeMessages.length]);

  function revealOlderMessages() {
    const pane = messagePaneRef.current;
    if (!pane || hiddenMessageCount <= 0) {
      return;
    }
    scrollRestoreRef.current = {
      scrollHeight: pane.scrollHeight,
      scrollTop: pane.scrollTop,
    };
    shouldStickToBottomRef.current = false;
    setVisibleMessageCount((current) => Math.min(props.activeMessages.length, current + messagePageSize));
  }

  useEffect(() => {
    const pane = messagePaneRef.current;
    if (!pane || !activeThreadId) {
      return;
    }
    const restoreAnchor = scrollRestoreRef.current;
    if (restoreAnchor) {
      pane.scrollTop = restoreAnchor.scrollTop + (pane.scrollHeight - restoreAnchor.scrollHeight);
      scrollRestoreRef.current = null;
      return;
    }
    if (!shouldStickToBottomRef.current) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      pane.scrollTop = pane.scrollHeight;
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThreadId, latestVisibleMessageId, visibleMessageCount]);

  function handleMessagePaneScroll() {
    const pane = messagePaneRef.current;
    if (!pane) {
      return;
    }
    const distanceFromBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom < 40;
    if (pane.scrollTop <= 24 && hiddenMessageCount > 0 && !scrollRestoreRef.current) {
      revealOlderMessages();
    }
  }

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
            {!props.isCompactLayout ? <p className="eyebrow">Conversation</p> : null}
            <h2>{props.activeThread?.title || "Choose a session to focus the chat"}</h2>
            {!props.isCompactLayout ? (
              <p className="chat-stage__subtitle">
                {props.activeThread ? threadPreview(props.activeThread) : "The phone view now keeps one conversation in focus instead of dumping the whole workspace on screen."}
              </p>
            ) : null}
          </div>
        </div>

        <div className="chat-stage__toolbar">
          {props.pendingApprovals.length > 0 ? (
            <span className="pill pill--warn">{props.pendingApprovals.length} approvals</span>
          ) : null}
          {!props.isCompactLayout ? (
            <button type="button" className="chip chip--ghost" onClick={props.onRefresh}>
              Refresh
            </button>
          ) : null}
        </div>
      </div>

      <div className="message-pane" ref={messagePaneRef} onScroll={handleMessagePaneScroll}>
        {!hasThread ? (
          <div className="message-pane__empty">
            <p>No session selected.</p>
            <span>Open a session from the rail and the transcript will stay inside this scrollable pane.</span>
          </div>
        ) : null}

        {hasThread && props.isThreadLoading && props.activeMessages.length === 0 ? (
          <div className="message-pane__loading">
            <p>Loading session…</p>
            <span>Koder is pulling the transcript from the Mac before opening this chat.</span>
          </div>
        ) : null}

        {hasThread && !props.isThreadLoading && hiddenMessageCount > 0 ? (
          <button type="button" className="message-pane__older" onClick={revealOlderMessages}>
            Show {Math.min(hiddenMessageCount, messagePageSize)} earlier messages
          </button>
        ) : null}

        {visibleMessages.map((message) => (
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

      <form className={`composer ${props.isCompactLayout ? "composer--compact" : ""}`} onSubmit={props.onSendSubmit}>
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
          Installed mode is what unlocks stronger PWA behavior later. Right now the browser can already raise local system alerts while a live session is connected.
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
            <p className="eyebrow">Access</p>
            <h2>Local host flow</h2>
          </div>
        </div>
        <ul className="bullet-list">
          <li>Run <code>./start.sh --ip &lt;your-mac-ip&gt;</code> on the Mac.</li>
          <li>Open this PWA from that same host or IP and Koder attaches directly to the live bridge.</li>
          <li>Everything stays self-hosted. There is no hosted cloud or QR-first onboarding path anymore.</li>
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

function DirectConnectPanel(props: {
  connection: ClientSnapshot["connection"];
  visibleError: string;
  trustedMacs: ClientSnapshot["trustedMacs"];
  busyAction: string | null;
  isCompactLayout: boolean;
  onConnect: () => void;
  onRetrySavedHost: () => void;
  onForgetCurrentHost: () => void;
}) {
  const localRelayHost = compactRelayLabel(preferredRelayUrlFromPage());
  const savedHostLabel = props.connection.macName || props.connection.macDeviceId || "None yet";
  const isWorking = props.connection.phase === "connecting" || props.connection.phase === "restoring";

  return (
    <div className="onboarding onboarding--direct">
      <div className="hero__header">
        <div>
          {!props.isCompactLayout ? <p className="eyebrow">Self-hosted access</p> : null}
          <h2>{props.isCompactLayout ? "Connect to this Koder host" : "Connect directly to this self-hosted Koder host."}</h2>
        </div>
        {!props.isCompactLayout ? <span className="pill">Local only</span> : null}
      </div>

      <p className="hero__lede">
        Open the PWA from the same host or IP that is running <code>./start.sh --ip &lt;your-mac-ip&gt;</code>. This browser now attaches straight to the live machine session on that host, without any QR, code, or legacy iOS pairing flow.
      </p>

      <div className="onboarding__focus onboarding__focus--direct">
        <article className="connection-tile">
          <span>Current host</span>
          <strong>{localRelayHost || "Unavailable"}</strong>
        </article>
        <article className="connection-tile">
          <span>Saved host</span>
          <strong>{savedHostLabel}</strong>
        </article>
        <article className="connection-tile">
          <span>Known hosts</span>
          <strong>{props.trustedMacs.length}</strong>
        </article>
      </div>

      <div className="recovery-card recovery-card--compact recovery-card--direct">
        <div className="recovery-card__header">
          <div>
            <p className="eyebrow">Status</p>
            <h3>{props.connection.label}</h3>
          </div>
          <span className={`pill ${props.connection.phase === "error" ? "pill--warn" : ""}`}>
            {props.connection.phase}
          </span>
        </div>

        <p className="recovery-card__copy">
          {props.visibleError || (isWorking
            ? "Koder is trying to attach to the live bridge on this host."
            : "Tap connect to attach this browser directly to the live self-hosted Koder session on this host.")}
        </p>

        <div className="recovery-card__actions">
          <button
            type="button"
            className="chip chip--primary"
            disabled={props.busyAction === "connect-local" || isWorking}
            onClick={props.onConnect}
          >
            {props.connection.phase === "error" ? "Retry connect" : "Connect"}
          </button>
          <button
            type="button"
            className="chip chip--ghost"
            disabled={props.busyAction === "restore" || isWorking}
            onClick={props.onRetrySavedHost}
          >
            Retry saved host
          </button>
          {(props.connection.macDeviceId || props.trustedMacs.length > 0) ? (
            <button
              type="button"
              className="chip chip--ghost chip--danger"
              onClick={props.onForgetCurrentHost}
            >
              Forget saved host
            </button>
          ) : null}
        </div>
      </div>
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
  return snapshot.connection.macName || relayHost || "No live host connected yet";
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
  return thread.agentNickname || thread.agentRole || "session";
}

function threadPreview(thread: ThreadSummary): string {
  return thread.preview || thread.subtitle || thread.cwd || "Open this session to continue the conversation.";
}

interface ThreadProjectGroup {
  key: string;
  label: string;
  pathLabel: string;
  threads: ThreadSummary[];
}

function buildThreadProjectGroups(threads: ThreadSummary[]): ThreadProjectGroup[] {
  const groups = new Map<string, ThreadProjectGroup>();

  for (const thread of threads) {
    const normalizedProjectPath = normalizeProjectPath(thread.cwd);
    const key = normalizedProjectPath ?? "__cloud__";
    const existing = groups.get(key);
    if (existing) {
      existing.threads.push(thread);
      continue;
    }

    groups.set(key, {
      key,
      label: projectDisplayLabel(normalizedProjectPath),
      pathLabel: normalizedProjectPath ?? "No local workspace path",
      threads: [thread],
    });
  }

  return Array.from(groups.values());
}

function normalizeProjectPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalizedRoot = normalizedFilesystemRootPath(trimmed);
  if (normalizedRoot) {
    return normalizedRoot;
  }

  const normalized = trimmed.replace(/[\\/]+$/, "") || "/";
  if (!isLikelyFilesystemPath(normalized)) {
    return null;
  }

  return normalized;
}

function normalizedFilesystemRootPath(value: string): string | null {
  if (value === "/") {
    return "/";
  }

  if (value.startsWith("~") && /^~\/+$/.test(value)) {
    return "~/";
  }

  if (/^[A-Za-z]:[\\/]+$/.test(value)) {
    return `${value[0]}:/`;
  }

  return null;
}

function isLikelyFilesystemPath(value: string): boolean {
  if (value === "/") {
    return true;
  }

  if (value.startsWith("/") || value.startsWith("~/") || value.startsWith("\\\\")) {
    return true;
  }

  return /^[A-Za-z]:[\\/]/.test(value);
}

function projectDisplayLabel(normalizedProjectPath: string | null): string {
  if (!normalizedProjectPath) {
    return "Cloud";
  }

  const baseLabel = projectBaseDisplayName(normalizedProjectPath);
  const worktreeToken = codexManagedWorktreeToken(normalizedProjectPath);
  if (!worktreeToken) {
    return baseLabel;
  }

  return `${baseLabel} [${worktreeToken}]`;
}

function projectBaseDisplayName(normalizedProjectPath: string): string {
  const parts = normalizedProjectPath.split(/[\\/]/).filter(Boolean);
  const lastPart = parts.at(-1);
  return lastPart && lastPart !== "/" ? lastPart : normalizedProjectPath;
}

function codexManagedWorktreeToken(normalizedProjectPath: string): string | null {
  const components = normalizedProjectPath.split(/[\\/]/).filter(Boolean);
  const worktreesIndex = components.indexOf("worktrees");
  if (worktreesIndex <= 0 || components[worktreesIndex - 1] !== ".codex") {
    return null;
  }

  const token = components[worktreesIndex + 1]?.trim();
  return token || null;
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
