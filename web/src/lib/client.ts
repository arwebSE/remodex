import { gcm } from "@noble/ciphers/aes.js";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import {
  buildPairingCodeResolveUrl,
  buildRelaySocketUrl,
  buildTrustedSessionResolveUrl,
  notificationText,
  parseApprovalRequest,
  parseThreadList,
  parseThreadReadMessages,
  parseThreadSummary,
  preferredTrustedMac,
  readServerErrorMessage,
  resolveThreadIdFromParams,
  resolveTurnIdFromParams,
  SECURE_HANDSHAKE_TAG,
  SECURE_PROTOCOL_VERSION,
  stringifyId,
  TRUSTED_SESSION_RESOLVE_TAG,
  validatePairingPayload,
} from "./protocol";
import {
  createRelaySessionRecord,
  createTrustedMacRecord,
  loadPersistedState,
  updatePersistedState,
} from "./storage";
import type {
  ApprovalRequest,
  ClientSnapshot,
  ConnectionSummary,
  ConversationMessage,
  PairingPayload,
  PersistedState,
  RpcMessage,
  SecureApplicationPayload,
  SecureClientAuth,
  SecureClientHello,
  SecureEnvelope,
  SecureErrorMessage,
  SecureReadyMessage,
  SecureResumeState,
  SecureServerHello,
  ThreadSummary,
  TrustedMacRecord,
  TrustedSessionResolveResponse,
} from "./types";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const WEB_CLIENT_VERSION = "0.2.0";
const REQUEST_TIMEOUT_MS = 20_000;
const SECURE_CONTROL_TIMEOUT_MS = 12_000;
const HTTP_REQUEST_TIMEOUT_MS = 10_000;

type Listener = (snapshot: ClientSnapshot) => void;

interface PendingSecureControlWaiter {
  resolve: (rawText: string) => void;
  reject: (error: Error) => void;
  timeout: number;
}

interface SecureSessionState {
  sessionId: string;
  keyEpoch: number;
  macDeviceId: string;
  macIdentityPublicKey: string;
  phoneToMacKey: Uint8Array;
  macToPhoneKey: Uint8Array;
  lastInboundCounter: number;
  nextOutboundCounter: number;
}

export class KoderClient {
  private persistedState: PersistedState;
  private snapshot: ClientSnapshot;
  private listeners = new Set<Listener>();
  private socket: WebSocket | null = null;
  private restorePromise: Promise<void> | null = null;
  private secureSession: SecureSessionState | null = null;
  private pendingRequests = new Map<string, {
    resolve: (message: RpcMessage) => void;
    reject: (error: Error) => void;
    timeout: number;
  }>();
  private pendingSecureControlWaiters = new Map<string, PendingSecureControlWaiter[]>();
  private bufferedSecureControlMessages = new Map<string, string[]>();
  private runningThreadIds = new Set<string>();
  private resumedThreadIds = new Set<string>();
  private activeAssistantMessageByTurn = new Map<string, string>();

  constructor() {
    this.persistedState = loadPersistedState();
    this.snapshot = {
      connection: buildInitialConnectionSummary(this.persistedState),
      threads: [],
      activeThreadId: null,
      messagesByThread: {},
      pendingApprovals: [],
      trustedMacs: trustedMacList(this.persistedState),
      lastError: "",
      isBusy: false,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): ClientSnapshot {
    return this.snapshot;
  }

  async restoreConnection(): Promise<void> {
    if (this.restorePromise) {
      return this.restorePromise;
    }
    if (
      this.snapshot.connection.phase === "restoring"
      || this.snapshot.connection.phase === "connecting"
      || this.snapshot.connection.phase === "connected"
    ) {
      return;
    }

    this.restorePromise = this.restoreConnectionInternal();
    try {
      await this.restorePromise;
    } finally {
      this.restorePromise = null;
    }
  }

  private async restoreConnectionInternal(): Promise<void> {
    this.setConnection({
      phase: "restoring",
      label: "Restoring saved pair...",
    });

    const records = trustedMacList(this.persistedState);
    const preferred = preferredTrustedMac(records, this.persistedState.lastTrustedMacDeviceId);
    if (preferred?.relayURL) {
      try {
        await this.reconnectToTrustedMac(preferred.macDeviceId, { quiet: true });
        return;
      } catch (error) {
        if (isRePairRequiredError(error)) {
          this.setConnection({
            phase: "error",
            secureState: "rePairRequired",
            label: "Re-pair required",
          });
          this.setLastError(error.message);
          return;
        }
      }
    }

    if (this.persistedState.relaySession) {
      try {
        await this.connectWithSavedSession({ quiet: true });
        return;
      } catch (error) {
        this.setLastError(error instanceof Error ? error.message : "Could not restore the saved session.");
      }
    }

    this.setConnection({
      phase: "idle",
      label: this.snapshot.connection.secureState === "trustedMac" ? "Trusted Mac ready" : "Pair a Mac to begin",
    });
  }

  async connectWithPairingPayload(payload: PairingPayload): Promise<void> {
    this.persistedState = updatePersistedState(this.persistedState, (draft) => {
      draft.relaySession = createRelaySessionRecord({
        relayUrl: payload.relay,
        sessionId: payload.sessionId,
        macDeviceId: payload.macDeviceId,
        macIdentityPublicKey: payload.macIdentityPublicKey,
        shouldForceQRBootstrapOnNextHandshake: true,
      });
      return draft;
    });

    this.syncTrustedMacs();
    await this.connectWithSavedSession();
  }

  async connectWithPairingCode(relayUrl: string, code: string): Promise<void> {
    const resolveUrl = buildPairingCodeResolveUrl(relayUrl);
    const normalizedCode = code.trim().toUpperCase().replace(/^RMX1:/, "").replace(/[^A-Z0-9]/g, "");
    if (!normalizedCode) {
      throw new Error("Enter a valid pairing code.");
    }

    const response = await postJSON<{
      ok?: boolean;
      v?: number;
      sessionId?: string;
      macDeviceId?: string;
      macIdentityPublicKey?: string;
      expiresAt?: number;
      error?: string;
      code?: string;
    }>(resolveUrl, { code: normalizedCode }, {
      timeoutMs: HTTP_REQUEST_TIMEOUT_MS,
      timeoutMessage: "Timed out while resolving the pairing code. Check the relay URL or scan a fresh QR.",
    });

    const payload = validatePairingPayload({
      v: response.v,
      relay: relayUrl,
      sessionId: response.sessionId,
      macDeviceId: response.macDeviceId,
      macIdentityPublicKey: response.macIdentityPublicKey,
      expiresAt: response.expiresAt,
    });

    await this.connectWithPairingPayload(payload);
  }

  async reconnectToTrustedMac(macDeviceId?: string, options: { quiet?: boolean } = {}): Promise<void> {
    const records = trustedMacList(this.persistedState);
    const selected = macDeviceId
      ? records.find((record) => record.macDeviceId === macDeviceId) ?? null
      : preferredTrustedMac(records, this.persistedState.lastTrustedMacDeviceId);

    if (!selected?.relayURL) {
      throw new Error("No trusted Mac is available to reconnect.");
    }

    if (!options.quiet) {
      this.setBusy(true);
      this.setConnection({
        phase: "connecting",
        secureState: "reconnecting",
        label: "Resolving trusted Mac...",
        relayUrl: selected.relayURL,
        macDeviceId: selected.macDeviceId,
        macName: selected.displayName ?? "",
      });
    }

    try {
      const resolved = await this.resolveTrustedMacSession(selected);
      this.persistedState = updatePersistedState(this.persistedState, (draft) => {
        draft.relaySession = createRelaySessionRecord({
          relayUrl: selected.relayURL ?? "",
          sessionId: resolved.sessionId,
          macDeviceId: resolved.macDeviceId,
          macIdentityPublicKey: resolved.macIdentityPublicKey,
          shouldForceQRBootstrapOnNextHandshake: false,
        });
        const existing = draft.trustedMacRegistry[resolved.macDeviceId] ?? createTrustedMacRecord(
          resolved.macDeviceId,
          resolved.macIdentityPublicKey,
          selected.relayURL,
          resolved.displayName
        );
        draft.trustedMacRegistry[resolved.macDeviceId] = {
          ...existing,
          relayURL: selected.relayURL,
          displayName: resolved.displayName ?? existing.displayName ?? null,
          lastResolvedSessionId: resolved.sessionId,
          lastResolvedAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
        };
        draft.lastTrustedMacDeviceId = resolved.macDeviceId;
        return draft;
      });
      this.syncTrustedMacs();
      await this.connectWithSavedSession({ quiet: options.quiet });
    } finally {
      if (!options.quiet) {
        this.setBusy(false);
      }
    }
  }

  async connectWithSavedSession(options: { quiet?: boolean } = {}): Promise<void> {
    const relaySession = this.persistedState.relaySession;
    if (!relaySession) {
      throw new Error("No saved pairing session is available.");
    }

    await this.disconnect({ preservePairing: true, preserveMessages: true });
    this.clearRuntimeState();

    if (!options.quiet) {
      this.setBusy(true);
    }
    this.setConnection({
      phase: "connecting",
      secureState: relaySession.shouldForceQRBootstrapOnNextHandshake ? "handshaking" : "reconnecting",
      label: relaySession.shouldForceQRBootstrapOnNextHandshake
        ? "Pairing securely..."
        : "Connecting to trusted Mac...",
      relayUrl: relaySession.relayUrl,
      macDeviceId: relaySession.macDeviceId,
      macName: this.persistedState.trustedMacRegistry[relaySession.macDeviceId]?.displayName ?? "",
    });
    this.setLastError("");

    try {
      await this.openRelaySocket(relaySession);
      await this.performSecureHandshake();
      await this.initializeSession();
      this.setConnection({
        phase: "connected",
        secureState: "encrypted",
        label: "End-to-end encrypted",
      });
      await this.refreshThreads();
      const activeThreadId = this.snapshot.activeThreadId ?? this.snapshot.threads[0]?.id ?? null;
      if (activeThreadId) {
        await this.openThread(activeThreadId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection failed.";
      this.setLastError(message);
      this.setConnection({
        phase: "error",
        label: message,
      });
      throw error instanceof Error ? error : new Error(message);
    } finally {
      if (!options.quiet) {
        this.setBusy(false);
      }
    }
  }

  async refreshThreads(): Promise<void> {
    const params = {
      limit: 70,
      sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"],
      cursor: null,
    };

    const response = await this.sendRequest("thread/list", params);
    const nextThreads = parseThreadList(response.result);
    const activeThreadId = this.snapshot.activeThreadId && nextThreads.some((thread) => thread.id === this.snapshot.activeThreadId)
      ? this.snapshot.activeThreadId
      : nextThreads[0]?.id ?? null;

    this.replaceSnapshot({
      ...this.snapshot,
      threads: nextThreads,
      activeThreadId,
    });
  }

  async createThread(): Promise<string> {
    const response = await this.sendRequest("thread/start", {});
    const thread = parseThreadSummary(asObject(asObject(response.result).thread) || response.result);
    if (!thread) {
      throw new Error("thread/start did not return a usable thread.");
    }

    this.upsertThread(thread, { select: true });
    this.resumedThreadIds.add(thread.id);
    this.replaceSnapshot({
      ...this.snapshot,
      messagesByThread: {
        ...this.snapshot.messagesByThread,
        [thread.id]: [],
      },
    });
    return thread.id;
  }

  async openThread(threadId: string): Promise<void> {
    this.replaceSnapshot({
      ...this.snapshot,
      activeThreadId: threadId,
    });

    if (!this.resumedThreadIds.has(threadId)) {
      try {
        const resumeResponse = await this.sendRequest("thread/resume", { threadId });
        const resumedThread = parseThreadSummary(asObject(asObject(resumeResponse.result).thread));
        if (resumedThread) {
          this.upsertThread(resumedThread);
        }
      } catch {
        // Best effort only. Some runtimes keep thread/read usable even if resume fails.
      }
      this.resumedThreadIds.add(threadId);
    }

    const readResponse = await this.sendRequest("thread/read", { threadId, includeTurns: true });
    const messages = parseThreadReadMessages(threadId, readResponse.result);
    this.replaceThreadMessages(threadId, messages);
  }

  async sendMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    if (this.snapshot.connection.phase !== "connected") {
      throw new Error("Connect to a Mac before sending a message.");
    }

    let threadId = this.snapshot.activeThreadId;
    if (!threadId) {
      threadId = await this.createThread();
    }

    const pendingMessageId = this.appendOptimisticUserMessage(threadId, trimmed);
    this.runningThreadIds.add(threadId);

    try {
      if (!this.resumedThreadIds.has(threadId)) {
        await this.openThread(threadId);
      }
      const response = await this.sendRequest("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: trimmed,
          },
        ],
      });
      const turnId = extractTurnId(response.result);
      this.confirmOutgoingUserMessage(threadId, pendingMessageId);
      if (turnId) {
        this.ensureAssistantMessage(threadId, turnId, null);
      }
      this.bumpThreadActivity(threadId);
    } catch (error) {
      this.markOutgoingUserMessageFailed(threadId, pendingMessageId);
      const message = error instanceof Error ? error.message : "Send failed.";
      this.setLastError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async respondToApproval(requestId: string, decision: "accept" | "reject"): Promise<void> {
    const approval = this.snapshot.pendingApprovals.find((entry) => entry.id === requestId);
    if (!approval) {
      return;
    }

    await this.sendResponse(approval.requestId, { decision });
    this.replaceSnapshot({
      ...this.snapshot,
      pendingApprovals: this.snapshot.pendingApprovals.filter((entry) => entry.id !== requestId),
    });
  }

  forgetReconnectCandidate(macDeviceId?: string): void {
    this.persistedState = updatePersistedState(this.persistedState, (draft) => {
      const targetId = macDeviceId ?? draft.lastTrustedMacDeviceId;
      if (targetId) {
        delete draft.trustedMacRegistry[targetId];
        if (draft.lastTrustedMacDeviceId === targetId) {
          draft.lastTrustedMacDeviceId = null;
        }
        if (draft.relaySession?.macDeviceId === targetId) {
          draft.relaySession = null;
        }
      } else {
        draft.relaySession = null;
        draft.lastTrustedMacDeviceId = null;
      }
      return draft;
    });
    this.syncTrustedMacs();
    this.setConnection(buildInitialConnectionSummary(this.persistedState));
  }

  async disconnect(options: { preservePairing?: boolean; preserveMessages?: boolean } = {}): Promise<void> {
    const activeSocket = this.socket;
    this.socket = null;
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.close();
    }

    this.failAllPendingRequests(new Error("Disconnected from the relay."));
    this.failAllPendingSecureControls(new Error("Disconnected before the secure transport finished."));
    this.secureSession = null;
    this.runningThreadIds.clear();
    this.activeAssistantMessageByTurn.clear();
    if (!options.preserveMessages) {
      this.replaceSnapshot({
        ...this.snapshot,
        messagesByThread: {},
      });
    }

    if (!options.preservePairing) {
      this.persistedState = updatePersistedState(this.persistedState, (draft) => {
        draft.relaySession = null;
        return draft;
      });
    }

    const preferred = preferredTrustedMac(trustedMacList(this.persistedState), this.persistedState.lastTrustedMacDeviceId);
    this.setConnection({
      phase: "disconnected",
      secureState: preferred ? "trustedMac" : "notPaired",
      label: preferred ? "Trusted Mac ready" : "Pair a Mac to begin",
      relayUrl: this.persistedState.relaySession?.relayUrl ?? preferred?.relayURL ?? "",
      macDeviceId: preferred?.macDeviceId ?? this.persistedState.relaySession?.macDeviceId ?? "",
      macName: preferred?.displayName ?? "",
    });
  }

  private async openRelaySocket(relaySession: NonNullable<PersistedState["relaySession"]>): Promise<void> {
    const socketUrl = buildRelaySocketUrl(relaySession.relayUrl, relaySession.sessionId, "iphone");
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(socketUrl);
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        socket.close();
        reject(new Error("Connection timed out while opening the relay socket."));
      }, 12_000);

      socket.addEventListener("open", () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.socket = socket;
        resolve();
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          this.processIncomingWireText(event.data);
        }
      });

      socket.addEventListener("close", (event) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Relay socket closed during connect (${event.code}).`));
        }
        this.handleSocketClose(event);
      });

      socket.addEventListener("error", () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Could not open the relay socket."));
      });
    });
  }

  private async performSecureHandshake(): Promise<void> {
    const relaySession = this.persistedState.relaySession;
    if (!relaySession) {
      throw new Error("No relay session is available for the secure handshake.");
    }

    const trustedMac = this.persistedState.trustedMacRegistry[relaySession.macDeviceId];
    const handshakeMode = (!relaySession.shouldForceQRBootstrapOnNextHandshake && trustedMac)
      ? "trusted_reconnect"
      : "qr_bootstrap";
    const expectedMacIdentityPublicKey = handshakeMode === "trusted_reconnect"
      ? trustedMac?.macIdentityPublicKey ?? ""
      : relaySession.macIdentityPublicKey;

    const phoneEphemeral = x25519.keygen();
    const clientNonce = randomBytes(32);
    const clientHello: SecureClientHello = {
      kind: "clientHello",
      protocolVersion: SECURE_PROTOCOL_VERSION,
      sessionId: relaySession.sessionId,
      handshakeMode,
      phoneDeviceId: this.persistedState.phoneIdentityState.phoneDeviceId,
      phoneIdentityPublicKey: this.persistedState.phoneIdentityState.phoneIdentityPublicKey,
      phoneEphemeralPublicKey: bytesToBase64(phoneEphemeral.publicKey),
      clientNonce: bytesToBase64(clientNonce),
    };
    await this.sendWireControlMessage(clientHello);

    const serverHello = await this.waitForMatchingServerHello({
      expectedSessionId: relaySession.sessionId,
      expectedMacDeviceId: relaySession.macDeviceId,
      expectedMacIdentityPublicKey,
      expectedClientNonce: clientHello.clientNonce,
      clientNonce,
      phoneDeviceId: this.persistedState.phoneIdentityState.phoneDeviceId,
      phoneIdentityPublicKey: this.persistedState.phoneIdentityState.phoneIdentityPublicKey,
      phoneEphemeralPublicKey: clientHello.phoneEphemeralPublicKey,
    });

    const transcriptBytes = buildSecureTranscriptBytes({
      sessionId: relaySession.sessionId,
      protocolVersion: serverHello.protocolVersion,
      handshakeMode: serverHello.handshakeMode,
      keyEpoch: serverHello.keyEpoch,
      macDeviceId: serverHello.macDeviceId,
      phoneDeviceId: this.persistedState.phoneIdentityState.phoneDeviceId,
      macIdentityPublicKey: serverHello.macIdentityPublicKey,
      phoneIdentityPublicKey: this.persistedState.phoneIdentityState.phoneIdentityPublicKey,
      macEphemeralPublicKey: serverHello.macEphemeralPublicKey,
      phoneEphemeralPublicKey: clientHello.phoneEphemeralPublicKey,
      clientNonce,
      serverNonce: base64ToBytes(serverHello.serverNonce),
      expiresAtForTranscript: serverHello.expiresAtForTranscript,
    });

    const isSignatureValid = ed25519.verify(
      base64ToBytes(serverHello.macSignature),
      transcriptBytes,
      base64ToBytes(serverHello.macIdentityPublicKey)
    );
    if (!isSignatureValid) {
      throw new Error("The secure Mac signature could not be verified.");
    }

    const phoneSignature = ed25519.sign(
      buildClientAuthTranscript(transcriptBytes),
      base64ToBytes(this.persistedState.phoneIdentityState.phoneIdentityPrivateKey)
    );
    const clientAuth: SecureClientAuth = {
      kind: "clientAuth",
      sessionId: relaySession.sessionId,
      phoneDeviceId: this.persistedState.phoneIdentityState.phoneDeviceId,
      keyEpoch: serverHello.keyEpoch,
      phoneSignature: bytesToBase64(phoneSignature),
    };
    await this.sendWireControlMessage(clientAuth);

    await this.waitForMatchingSecureReady({
      expectedSessionId: relaySession.sessionId,
      expectedKeyEpoch: serverHello.keyEpoch,
      expectedMacDeviceId: relaySession.macDeviceId,
    });

    const sharedSecret = x25519.getSharedSecret(
      phoneEphemeral.secretKey,
      base64ToBytes(serverHello.macEphemeralPublicKey)
    );
    const salt = sha256(transcriptBytes);
    const infoPrefix = `${SECURE_HANDSHAKE_TAG}|${relaySession.sessionId}|${serverHello.macDeviceId}|${this.persistedState.phoneIdentityState.phoneDeviceId}|${serverHello.keyEpoch}`;

    this.secureSession = {
      sessionId: relaySession.sessionId,
      keyEpoch: serverHello.keyEpoch,
      macDeviceId: serverHello.macDeviceId,
      macIdentityPublicKey: serverHello.macIdentityPublicKey,
      phoneToMacKey: hkdf(sha256, sharedSecret, salt, textEncoder.encode(`${infoPrefix}|phoneToMac`), 32),
      macToPhoneKey: hkdf(sha256, sharedSecret, salt, textEncoder.encode(`${infoPrefix}|macToPhone`), 32),
      lastInboundCounter: -1,
      nextOutboundCounter: 0,
    };

    if (handshakeMode === "qr_bootstrap") {
      this.persistedState = updatePersistedState(this.persistedState, (draft) => {
        draft.relaySession = createRelaySessionRecord({
          relayUrl: relaySession.relayUrl,
          sessionId: relaySession.sessionId,
          macDeviceId: serverHello.macDeviceId,
          macIdentityPublicKey: serverHello.macIdentityPublicKey,
          shouldForceQRBootstrapOnNextHandshake: false,
        });
        draft.trustedMacRegistry[serverHello.macDeviceId] = {
          ...createTrustedMacRecord(
            serverHello.macDeviceId,
            serverHello.macIdentityPublicKey,
            relaySession.relayUrl,
            draft.trustedMacRegistry[serverHello.macDeviceId]?.displayName ?? null
          ),
          relayURL: relaySession.relayUrl,
          displayName: draft.trustedMacRegistry[serverHello.macDeviceId]?.displayName ?? null,
          lastUsedAt: new Date().toISOString(),
        };
        draft.lastTrustedMacDeviceId = serverHello.macDeviceId;
        return draft;
      });
    } else {
      this.persistedState = updatePersistedState(this.persistedState, (draft) => {
        if (draft.relaySession) {
          draft.relaySession.shouldForceQRBootstrapOnNextHandshake = false;
        }
        if (draft.trustedMacRegistry[serverHello.macDeviceId]) {
          draft.trustedMacRegistry[serverHello.macDeviceId].lastUsedAt = new Date().toISOString();
        }
        draft.lastTrustedMacDeviceId = serverHello.macDeviceId;
        return draft;
      });
    }
    this.syncTrustedMacs();

    const resumeState: SecureResumeState = {
      kind: "resumeState",
      sessionId: relaySession.sessionId,
      keyEpoch: serverHello.keyEpoch,
      lastAppliedBridgeOutboundSeq: this.persistedState.relaySession?.lastAppliedBridgeOutboundSeq ?? 0,
    };
    await this.sendWireControlMessage(resumeState);
  }

  private async initializeSession(): Promise<void> {
    const clientInfo = {
      name: "koder_web",
      title: "Koder Web",
      version: WEB_CLIENT_VERSION,
    };

    try {
      await this.sendRequest("initialize", {
        clientInfo,
        capabilities: {
          experimentalApi: true,
        },
      });
    } catch {
      await this.sendRequest("initialize", { clientInfo });
    }

    await this.sendNotification("initialized", null);
  }

  private async resolveTrustedMacSession(record: TrustedMacRecord): Promise<TrustedSessionResolveResponse> {
    if (!record.relayURL) {
      throw new Error("This trusted Mac does not have a saved relay URL.");
    }

    const url = buildTrustedSessionResolveUrl(record.relayURL);
    const nonce = createRandomUUID();
    const timestamp = Date.now();
    const transcript = buildTrustedResolveTranscriptBytes({
      macDeviceId: record.macDeviceId,
      phoneDeviceId: this.persistedState.phoneIdentityState.phoneDeviceId,
      phoneIdentityPublicKey: this.persistedState.phoneIdentityState.phoneIdentityPublicKey,
      nonce,
      timestamp,
    });
    const signature = ed25519.sign(
      transcript,
      base64ToBytes(this.persistedState.phoneIdentityState.phoneIdentityPrivateKey)
    );

    try {
      return await postJSON<TrustedSessionResolveResponse>(url, {
        macDeviceId: record.macDeviceId,
        phoneDeviceId: this.persistedState.phoneIdentityState.phoneDeviceId,
        phoneIdentityPublicKey: this.persistedState.phoneIdentityState.phoneIdentityPublicKey,
        nonce,
        timestamp,
        signature: bytesToBase64(signature),
      }, {
        timeoutMs: HTTP_REQUEST_TIMEOUT_MS,
        timeoutMessage: "Timed out while contacting the trusted Mac relay. Try reconnecting once, then scan a fresh QR if it keeps stalling.",
      });
    } catch (error) {
      if (isCodedError(error, "phone_not_trusted") || isCodedError(error, "invalid_signature")) {
        throw codedError("This browser is no longer trusted by the Mac. Pair again from a fresh code.", "re_pair_required");
      }
      throw error instanceof Error
        ? error
        : new Error("Could not resolve the trusted Mac session.");
    }
  }

  private processIncomingWireText(text: string): void {
    const kind = wireMessageKind(text);
    if (kind === "serverHello" || kind === "secureReady" || kind === "secureError") {
      this.bufferSecureControlMessage(kind, text);
      return;
    }

    if (kind === "encryptedEnvelope") {
      void this.handleEncryptedEnvelopeText(text);
      return;
    }

    this.processIncomingPlaintext(text);
  }

  private processIncomingPlaintext(text: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(text) as RpcMessage;
    } catch {
      this.setLastError("Unable to decode server payload.");
      return;
    }

    if (message.method) {
      if (message.id != null) {
        void this.handleServerRequest(message);
      } else {
        void this.handleNotification(message.method, message.params);
      }
      return;
    }

    if (message.id == null) {
      return;
    }

    const requestId = stringifyId(message.id);
    const waiter = this.pendingRequests.get(requestId);
    if (!waiter) {
      return;
    }

    window.clearTimeout(waiter.timeout);
    this.pendingRequests.delete(requestId);
    if (message.error) {
      waiter.reject(makeRpcError(message.error));
      return;
    }
    waiter.resolve(message);
  }

  private async handleServerRequest(message: RpcMessage): Promise<void> {
    const approval = parseApprovalRequest(message);
    if (approval) {
      this.replaceSnapshot({
        ...this.snapshot,
        pendingApprovals: dedupeApprovals([...this.snapshot.pendingApprovals, approval]),
      });
      return;
    }

    const requestId = stringifyId(message.id);
    await this.sendErrorResponse(
      requestId,
      -32601,
      `Unsupported request method: ${message.method ?? "unknown"}`
    );
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    const threadId = resolveThreadIdFromParams(params);
    const turnId = resolveTurnIdFromParams(params);
    const paramsObject = asObject(params);

    switch (method) {
      case "thread/started": {
        const thread = parseThreadSummary(paramsObject.thread ?? paramsObject);
        if (thread) {
          this.upsertThread(thread, { select: this.snapshot.activeThreadId == null });
        }
        break;
      }
      case "thread/name/updated": {
        const nextTitle = normalizeString(paramsObject.name) || normalizeString(paramsObject.title);
        if (threadId && nextTitle) {
          this.updateThread(threadId, (thread) => ({ ...thread, title: nextTitle }));
        }
        break;
      }
      case "turn/started":
        if (threadId) {
          this.runningThreadIds.add(threadId);
        }
        break;
      case "turn/completed":
        if (threadId) {
          this.runningThreadIds.delete(threadId);
        }
        if (threadId) {
          this.finalizeAssistantMessage(threadId, turnId, null, notificationText(paramsObject));
          try {
            await this.openThread(threadId);
          } catch {
            // The live stream already has a usable local transcript.
          }
        }
        break;
      case "item/agentMessage/delta":
      case "codex/event/agent_message_content_delta":
      case "codex/event/agent_message_delta": {
        if (threadId) {
          const delta = notificationText(paramsObject);
          if (delta) {
            this.appendAssistantDelta(threadId, turnId, normalizeNullableString(paramsObject.itemId), delta);
          }
        }
        break;
      }
      case "codex/event/user_message":
        if (threadId) {
          const mirroredText = notificationText(paramsObject);
          if (mirroredText) {
            this.appendMirroredUserMessage(threadId, turnId, mirroredText);
          }
        }
        break;
      case "item/completed":
      case "codex/event/item_completed":
      case "codex/event/agent_message":
        if (threadId) {
          this.finalizeAssistantMessage(
            threadId,
            turnId,
            normalizeNullableString(paramsObject.itemId),
            notificationText(paramsObject)
          );
        }
        break;
      case "error":
      case "codex/event/error":
      case "turn/failed":
        if (threadId) {
          this.runningThreadIds.delete(threadId);
        }
        this.setLastError(readServerErrorMessage(paramsObject, "The runtime reported an error."));
        break;
      case "serverRequest/resolved": {
        const requestId = stringifyId(paramsObject.requestId as string | number | null | undefined);
        if (requestId) {
          this.replaceSnapshot({
            ...this.snapshot,
            pendingApprovals: this.snapshot.pendingApprovals.filter((entry) => entry.requestId !== requestId),
          });
        }
        break;
      }
      default:
        break;
    }
  }

  private async handleEncryptedEnvelopeText(text: string): Promise<void> {
    if (!this.secureSession) {
      return;
    }

    let envelope: SecureEnvelope;
    try {
      envelope = JSON.parse(text) as SecureEnvelope;
    } catch {
      this.setLastError("The encrypted relay envelope could not be decoded.");
      return;
    }

    if (
      envelope.sessionId !== this.secureSession.sessionId
      || envelope.keyEpoch !== this.secureSession.keyEpoch
      || envelope.sender !== "mac"
      || !Number.isInteger(envelope.counter)
      || envelope.counter <= this.secureSession.lastInboundCounter
    ) {
      return;
    }

    try {
      const payloadBytes = decryptEnvelopePayload(
        envelope,
        this.secureSession.macToPhoneKey,
        "mac",
        envelope.counter
      );
      const payload = JSON.parse(textDecoder.decode(payloadBytes)) as SecureApplicationPayload;
      this.secureSession.lastInboundCounter = envelope.counter;

      if (payload.bridgeOutboundSeq && this.persistedState.relaySession) {
        if (payload.bridgeOutboundSeq > this.persistedState.relaySession.lastAppliedBridgeOutboundSeq) {
          this.persistedState = updatePersistedState(this.persistedState, (draft) => {
            if (draft.relaySession) {
              draft.relaySession.lastAppliedBridgeOutboundSeq = payload.bridgeOutboundSeq ?? 0;
            }
            return draft;
          });
        }
      }

      if (payload.payloadText) {
        this.processIncomingPlaintext(payload.payloadText);
      }
    } catch (error) {
      this.applySecureError({
        kind: "secureError",
        code: "decrypt_failed",
        message: error instanceof Error ? error.message : "Could not decrypt the secure payload.",
      });
    }
  }

  private async sendRequest(method: string, params: unknown): Promise<RpcMessage> {
    this.ensureSecureChannelReady();
    const requestId = createRandomUUID();

    return new Promise<RpcMessage>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
      });

      void this.sendRpcMessage({
        id: requestId,
        method,
        params,
      }).catch((error) => {
        window.clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(error);
      });
    });
  }

  private async sendNotification(method: string, params: unknown): Promise<void> {
    this.ensureSecureChannelReady();
    await this.sendRpcMessage({ method, params });
  }

  private async sendResponse(id: string, result: unknown): Promise<void> {
    this.ensureSecureChannelReady();
    await this.sendRpcMessage({ id, result });
  }

  private async sendErrorResponse(id: string, code: number, message: string): Promise<void> {
    this.ensureSecureChannelReady();
    await this.sendRpcMessage({
      id,
      error: {
        code,
        message,
      },
    });
  }

  private async sendRpcMessage(message: RpcMessage): Promise<void> {
    const plaintext = JSON.stringify(message);
    const secureText = this.secureWireText(plaintext);
    this.sendRawText(secureText);
  }

  private secureWireText(plaintext: string): string {
    if (!this.secureSession) {
      throw new Error("The secure session is not ready yet.");
    }

    const envelope = encryptEnvelopePayload(
      {
        bridgeOutboundSeq: null,
        payloadText: plaintext,
      },
      this.secureSession.phoneToMacKey,
      "iphone",
      this.secureSession.nextOutboundCounter,
      this.secureSession.sessionId,
      this.secureSession.keyEpoch
    );
    this.secureSession.nextOutboundCounter += 1;
    return JSON.stringify(envelope);
  }

  private sendRawText(text: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("The relay socket is not open.");
    }

    this.socket.send(text);
  }

  private async sendWireControlMessage(value: unknown): Promise<void> {
    this.sendRawText(JSON.stringify(value));
  }

  private waitForSecureControlMessage(kind: string, timeoutMs = SECURE_CONTROL_TIMEOUT_MS): Promise<string> {
    const bufferedSecureError = this.bufferedSecureControlMessages.get("secureError")?.shift();
    if (bufferedSecureError) {
      const secureError = JSON.parse(bufferedSecureError) as SecureErrorMessage;
      return Promise.reject(new Error(secureError.message));
    }

    const buffered = this.bufferedSecureControlMessages.get(kind);
    if (buffered?.length) {
      return Promise.resolve(buffered.shift() ?? "");
    }

    return new Promise<string>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.removeSecureControlWaiter(kind, resolve, reject);
        reject(new Error(`Timed out waiting for ${kind}.`));
      }, timeoutMs);

      const waiter: PendingSecureControlWaiter = { resolve, reject, timeout };
      const waiters = this.pendingSecureControlWaiters.get(kind) ?? [];
      waiters.push(waiter);
      this.pendingSecureControlWaiters.set(kind, waiters);
    });
  }

  private bufferSecureControlMessage(kind: string, rawText: string): void {
    if (kind === "secureError") {
      const secureError = JSON.parse(rawText) as SecureErrorMessage;
      this.applySecureError(secureError);
      return;
    }

    const waiters = this.pendingSecureControlWaiters.get(kind);
    if (waiters?.length) {
      const waiter = waiters.shift();
      if (waiters.length === 0) {
        this.pendingSecureControlWaiters.delete(kind);
      }
      if (waiter) {
        window.clearTimeout(waiter.timeout);
        waiter.resolve(rawText);
        return;
      }
    }

    const buffered = this.bufferedSecureControlMessages.get(kind) ?? [];
    buffered.push(rawText);
    this.bufferedSecureControlMessages.set(kind, buffered);
  }

  private applySecureError(error: SecureErrorMessage): void {
    this.setLastError(error.message);
    if (error.code === "update_required") {
      this.setConnection({
        phase: "error",
        secureState: "updateRequired",
        label: error.message,
      });
    } else if (error.code === "pairing_expired"
      || error.code === "phone_not_trusted"
      || error.code === "phone_identity_changed") {
      this.setConnection({
        phase: "error",
        secureState: "rePairRequired",
        label: error.message,
      });
    } else {
      this.setConnection({
        phase: "error",
        label: error.message,
      });
    }

    this.failAllPendingSecureControls(new Error(error.message));
  }

  private async waitForMatchingServerHello(expected: {
    expectedSessionId: string;
    expectedMacDeviceId: string;
    expectedMacIdentityPublicKey: string;
    expectedClientNonce: string;
    clientNonce: Uint8Array;
    phoneDeviceId: string;
    phoneIdentityPublicKey: string;
    phoneEphemeralPublicKey: string;
  }): Promise<SecureServerHello> {
    while (true) {
      const raw = await this.waitForSecureControlMessage("serverHello");
      const serverHello = JSON.parse(raw) as SecureServerHello;

      if (serverHello.clientNonce && serverHello.clientNonce !== expected.expectedClientNonce) {
        continue;
      }
      if (serverHello.protocolVersion !== SECURE_PROTOCOL_VERSION) {
        throw new Error("This bridge is using a different secure transport version.");
      }
      if (serverHello.sessionId !== expected.expectedSessionId) {
        continue;
      }
      if (serverHello.macDeviceId !== expected.expectedMacDeviceId) {
        throw new Error("The bridge reported a different Mac identity for this relay session.");
      }
      if (serverHello.macIdentityPublicKey !== expected.expectedMacIdentityPublicKey) {
        throw new Error("The secure Mac identity key did not match the paired device.");
      }
      const transcript = buildSecureTranscriptBytes({
        sessionId: expected.expectedSessionId,
        protocolVersion: serverHello.protocolVersion,
        handshakeMode: serverHello.handshakeMode,
        keyEpoch: serverHello.keyEpoch,
        macDeviceId: serverHello.macDeviceId,
        phoneDeviceId: expected.phoneDeviceId,
        macIdentityPublicKey: serverHello.macIdentityPublicKey,
        phoneIdentityPublicKey: expected.phoneIdentityPublicKey,
        macEphemeralPublicKey: serverHello.macEphemeralPublicKey,
        phoneEphemeralPublicKey: expected.phoneEphemeralPublicKey,
        clientNonce: expected.clientNonce,
        serverNonce: base64ToBytes(serverHello.serverNonce),
        expiresAtForTranscript: serverHello.expiresAtForTranscript,
      });

      const valid = ed25519.verify(
        base64ToBytes(serverHello.macSignature),
        transcript,
        base64ToBytes(serverHello.macIdentityPublicKey)
      );
      if (!valid) {
        continue;
      }

      return serverHello;
    }
  }

  private async waitForMatchingSecureReady(expected: {
    expectedSessionId: string;
    expectedKeyEpoch: number;
    expectedMacDeviceId: string;
  }): Promise<SecureReadyMessage> {
    while (true) {
      const raw = await this.waitForSecureControlMessage("secureReady");
      const ready = JSON.parse(raw) as SecureReadyMessage;
      if (
        ready.sessionId === expected.expectedSessionId
        && ready.keyEpoch === expected.expectedKeyEpoch
        && ready.macDeviceId === expected.expectedMacDeviceId
      ) {
        return ready;
      }
    }
  }

  private handleSocketClose(event: CloseEvent): void {
    if (!this.socket || event.target !== this.socket) {
      return;
    }

    this.socket = null;
    this.secureSession = null;
    this.failAllPendingRequests(new Error("Disconnected from the relay."));
    this.failAllPendingSecureControls(new Error("Disconnected from the relay."));

    const secureState = event.code === 4000 ? "rePairRequired" : this.snapshot.connection.secureState;
    const label = event.code === 4000
      ? "Saved pairing is no longer valid. Pair again."
      : event.code === 4002
        ? "The Mac session is unavailable right now."
        : event.code === 4004
          ? "The Mac briefly dropped off the relay."
          : "Disconnected from relay.";

    this.setConnection({
      phase: "disconnected",
      secureState,
      label,
    });
  }

  private clearRuntimeState(): void {
    this.pendingRequests.forEach((entry) => window.clearTimeout(entry.timeout));
    this.pendingRequests.clear();
    this.pendingSecureControlWaiters.forEach((waiters) => {
      waiters.forEach((waiter) => window.clearTimeout(waiter.timeout));
    });
    this.pendingSecureControlWaiters.clear();
    this.bufferedSecureControlMessages.clear();
    this.secureSession = null;
    this.runningThreadIds.clear();
    this.resumedThreadIds.clear();
    this.activeAssistantMessageByTurn.clear();
  }

  private failAllPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private failAllPendingSecureControls(error: Error): void {
    for (const waiters of this.pendingSecureControlWaiters.values()) {
      for (const waiter of waiters) {
        window.clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    }
    this.pendingSecureControlWaiters.clear();
  }

  private removeSecureControlWaiter(
    kind: string,
    resolve: (rawText: string) => void,
    reject: (error: Error) => void
  ): void {
    const waiters = this.pendingSecureControlWaiters.get(kind);
    if (!waiters) {
      return;
    }

    const nextWaiters = waiters.filter((waiter) => waiter.resolve !== resolve || waiter.reject !== reject);
    if (nextWaiters.length === 0) {
      this.pendingSecureControlWaiters.delete(kind);
      return;
    }

    this.pendingSecureControlWaiters.set(kind, nextWaiters);
  }

  private ensureSecureChannelReady(): void {
    if (!this.secureSession || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("The secure connection is not ready.");
    }
  }

  private syncTrustedMacs(): void {
    this.replaceSnapshot({
      ...this.snapshot,
      trustedMacs: trustedMacList(this.persistedState),
    });
  }

  private setBusy(isBusy: boolean): void {
    this.replaceSnapshot({
      ...this.snapshot,
      isBusy,
    });
  }

  private setLastError(lastError: string): void {
    this.replaceSnapshot({
      ...this.snapshot,
      lastError,
    });
  }

  private setConnection(partial: Partial<ConnectionSummary>): void {
    this.replaceSnapshot({
      ...this.snapshot,
      connection: {
        ...this.snapshot.connection,
        ...partial,
      },
    });
  }

  private replaceSnapshot(nextSnapshot: ClientSnapshot): void {
    this.snapshot = nextSnapshot;
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  private upsertThread(thread: ThreadSummary, options: { select?: boolean } = {}): void {
    const existing = this.snapshot.threads.filter((entry) => entry.id !== thread.id);
    const nextThreads = [...existing, thread].sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt ?? "") || 0;
      const rightTime = Date.parse(right.updatedAt ?? "") || 0;
      return rightTime - leftTime;
    });

    this.replaceSnapshot({
      ...this.snapshot,
      threads: nextThreads,
      activeThreadId: options.select ? thread.id : this.snapshot.activeThreadId,
    });
  }

  private updateThread(threadId: string, updater: (thread: ThreadSummary) => ThreadSummary): void {
    const nextThreads = this.snapshot.threads.map((thread) => thread.id === threadId ? updater(thread) : thread);
    this.replaceSnapshot({
      ...this.snapshot,
      threads: nextThreads,
    });
  }

  private replaceThreadMessages(threadId: string, messages: ConversationMessage[]): void {
    this.replaceSnapshot({
      ...this.snapshot,
      messagesByThread: {
        ...this.snapshot.messagesByThread,
        [threadId]: messages,
      },
    });
  }

  private appendOptimisticUserMessage(threadId: string, text: string): string {
    const messageId = createRandomUUID();
    const nextMessage: ConversationMessage = {
      id: messageId,
      threadId,
      role: "user",
      kind: "chat",
      text,
      createdAt: new Date().toISOString(),
      isStreaming: false,
      deliveryState: "pending",
      turnId: null,
      itemId: null,
    };

    const existing = this.snapshot.messagesByThread[threadId] ?? [];
    this.replaceThreadMessages(threadId, [...existing, nextMessage]);
    return messageId;
  }

  private appendMirroredUserMessage(threadId: string, turnId: string, text: string): void {
    const existing = this.snapshot.messagesByThread[threadId] ?? [];
    const duplicate = existing.find((message) => (
      message.role === "user"
      && message.text.trim() === text.trim()
      && (message.turnId == null || message.turnId === turnId)
    ));
    if (duplicate) {
      this.confirmOutgoingUserMessage(threadId, duplicate.id, turnId);
      return;
    }

    this.replaceThreadMessages(threadId, [...existing, {
      id: createRandomUUID(),
      threadId,
      role: "user",
      kind: "chat",
      text,
      createdAt: new Date().toISOString(),
      turnId,
      itemId: null,
      isStreaming: false,
      deliveryState: "confirmed",
    }]);
  }

  private confirmOutgoingUserMessage(threadId: string, messageId: string, turnId?: string | null): void {
    const nextMessages = (this.snapshot.messagesByThread[threadId] ?? []).map((message) => (
      message.id === messageId
        ? {
            ...message,
            deliveryState: "confirmed" as const,
            turnId: turnId ?? message.turnId ?? null,
          }
        : message
    ));
    this.replaceThreadMessages(threadId, nextMessages);
  }

  private markOutgoingUserMessageFailed(threadId: string, messageId: string): void {
    const nextMessages = (this.snapshot.messagesByThread[threadId] ?? []).map((message) => (
      message.id === messageId
        ? {
            ...message,
            deliveryState: "failed" as const,
          }
        : message
    ));
    this.replaceThreadMessages(threadId, nextMessages);
  }

  private ensureAssistantMessage(threadId: string, turnId: string, itemId: string | null): string {
    const key = assistantStreamKey(threadId, turnId, itemId);
    const existingMessageId = this.activeAssistantMessageByTurn.get(key);
    const existingMessages = this.snapshot.messagesByThread[threadId] ?? [];
    if (existingMessageId && existingMessages.some((message) => message.id === existingMessageId)) {
      return existingMessageId;
    }

    const messageId = createRandomUUID();
    this.activeAssistantMessageByTurn.set(key, messageId);
    this.replaceThreadMessages(threadId, [...existingMessages, {
      id: messageId,
      threadId,
      role: "assistant",
      kind: "chat",
      text: "",
      createdAt: new Date().toISOString(),
      turnId,
      itemId,
      isStreaming: true,
      deliveryState: "confirmed",
    }]);
    return messageId;
  }

  private appendAssistantDelta(threadId: string, turnId: string, itemId: string | null, delta: string): void {
    const messageId = this.ensureAssistantMessage(threadId, turnId, itemId);
    const nextMessages = (this.snapshot.messagesByThread[threadId] ?? []).map((message) => (
      message.id === messageId
        ? {
            ...message,
            text: `${message.text}${delta}`,
            isStreaming: true,
          }
        : message
    ));
    this.replaceThreadMessages(threadId, nextMessages);
  }

  private finalizeAssistantMessage(
    threadId: string,
    turnId: string,
    itemId: string | null,
    finalText: string
  ): void {
    const key = assistantStreamKey(threadId, turnId, itemId);
    const messageId = this.ensureAssistantMessage(threadId, turnId, itemId);
    const nextMessages = (this.snapshot.messagesByThread[threadId] ?? []).map((message) => {
      if (message.id !== messageId) {
        return message;
      }
      return {
        ...message,
        text: finalText.trim() || message.text,
        isStreaming: false,
      };
    });
    this.activeAssistantMessageByTurn.delete(key);
    this.replaceThreadMessages(threadId, nextMessages);
  }

  private bumpThreadActivity(threadId: string): void {
    this.updateThread(threadId, (thread) => ({
      ...thread,
      updatedAt: new Date().toISOString(),
      preview: thread.preview,
    }));
  }
}

function buildInitialConnectionSummary(state: PersistedState): ConnectionSummary {
  const trusted = preferredTrustedMac(trustedMacList(state), state.lastTrustedMacDeviceId);
  const relaySession = state.relaySession;

  if (trusted) {
    return {
      phase: "idle",
      secureState: "trustedMac",
      label: "Trusted Mac ready",
      relayUrl: trusted.relayURL ?? relaySession?.relayUrl ?? "",
      macDeviceId: trusted.macDeviceId,
      macName: trusted.displayName ?? "",
    };
  }

  return {
    phase: "idle",
    secureState: relaySession ? "trustedMac" : "notPaired",
    label: relaySession ? "Saved session ready" : "Pair a Mac to begin",
    relayUrl: relaySession?.relayUrl ?? "",
    macDeviceId: relaySession?.macDeviceId ?? "",
    macName: "",
  };
}

function trustedMacList(state: PersistedState): TrustedMacRecord[] {
  return Object.values(state.trustedMacRegistry);
}

function wireMessageKind(text: string): string {
  try {
    const parsed = JSON.parse(text) as { kind?: string };
    return typeof parsed.kind === "string" ? parsed.kind : "";
  } catch {
    return "";
  }
}

function buildSecureTranscriptBytes(payload: {
  sessionId: string;
  protocolVersion: number;
  handshakeMode: "qr_bootstrap" | "trusted_reconnect";
  keyEpoch: number;
  macDeviceId: string;
  phoneDeviceId: string;
  macIdentityPublicKey: string;
  phoneIdentityPublicKey: string;
  macEphemeralPublicKey: string;
  phoneEphemeralPublicKey: string;
  clientNonce: Uint8Array;
  serverNonce: Uint8Array;
  expiresAtForTranscript: number;
}): Uint8Array {
  return concatBytes(
    encodeLengthPrefixedUtf8(SECURE_HANDSHAKE_TAG),
    encodeLengthPrefixedUtf8(payload.sessionId),
    encodeLengthPrefixedUtf8(String(payload.protocolVersion)),
    encodeLengthPrefixedUtf8(payload.handshakeMode),
    encodeLengthPrefixedUtf8(String(payload.keyEpoch)),
    encodeLengthPrefixedUtf8(payload.macDeviceId),
    encodeLengthPrefixedUtf8(payload.phoneDeviceId),
    encodeLengthPrefixedBytes(base64ToBytes(payload.macIdentityPublicKey)),
    encodeLengthPrefixedBytes(base64ToBytes(payload.phoneIdentityPublicKey)),
    encodeLengthPrefixedBytes(base64ToBytes(payload.macEphemeralPublicKey)),
    encodeLengthPrefixedBytes(base64ToBytes(payload.phoneEphemeralPublicKey)),
    encodeLengthPrefixedBytes(payload.clientNonce),
    encodeLengthPrefixedBytes(payload.serverNonce),
    encodeLengthPrefixedUtf8(String(payload.expiresAtForTranscript))
  );
}

function buildClientAuthTranscript(transcriptBytes: Uint8Array): Uint8Array {
  return concatBytes(transcriptBytes, encodeLengthPrefixedUtf8("client-auth"));
}

function buildTrustedResolveTranscriptBytes(payload: {
  macDeviceId: string;
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
  nonce: string;
  timestamp: number;
}): Uint8Array {
  return concatBytes(
    encodeLengthPrefixedUtf8(TRUSTED_SESSION_RESOLVE_TAG),
    encodeLengthPrefixedUtf8(payload.macDeviceId),
    encodeLengthPrefixedUtf8(payload.phoneDeviceId),
    encodeLengthPrefixedBytes(base64ToBytes(payload.phoneIdentityPublicKey)),
    encodeLengthPrefixedUtf8(payload.nonce),
    encodeLengthPrefixedUtf8(String(payload.timestamp))
  );
}

function encryptEnvelopePayload(
  payload: SecureApplicationPayload,
  key: Uint8Array,
  sender: "mac" | "iphone",
  counter: number,
  sessionId: string,
  keyEpoch: number
): SecureEnvelope {
  const plaintext = textEncoder.encode(JSON.stringify(payload));
  const nonce = nonceForDirection(sender, counter);
  const encrypted = gcm(key, nonce).encrypt(plaintext);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const tag = encrypted.subarray(encrypted.length - 16);

  return {
    kind: "encryptedEnvelope",
    v: SECURE_PROTOCOL_VERSION,
    sessionId,
    keyEpoch,
    sender,
    counter,
    ciphertext: bytesToBase64(ciphertext),
    tag: bytesToBase64(tag),
  };
}

function decryptEnvelopePayload(
  envelope: SecureEnvelope,
  key: Uint8Array,
  sender: "mac" | "iphone",
  counter: number
): Uint8Array {
  const nonce = nonceForDirection(sender, counter);
  const ciphertext = concatBytes(base64ToBytes(envelope.ciphertext), base64ToBytes(envelope.tag));
  return gcm(key, nonce).decrypt(ciphertext);
}

function nonceForDirection(sender: "mac" | "iphone", counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce[0] = sender === "mac" ? 1 : 2;
  let value = BigInt(counter);
  for (let index = 11; index >= 1; index -= 1) {
    nonce[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return nonce;
}

function extractTurnId(result: unknown): string {
  const object = asObject(result);
  return normalizeString(object.turnId)
    || normalizeString(object.turn_id)
    || normalizeString(asObject(object.turn).id);
}

function assistantStreamKey(threadId: string, turnId: string, itemId: string | null): string {
  return `${threadId}:${turnId}:${itemId ?? "message"}`;
}

function dedupeApprovals(entries: ApprovalRequest[]): ApprovalRequest[] {
  const byId = new Map<string, ApprovalRequest>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized || null;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function createRandomUUID(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function encodeLengthPrefixedUtf8(value: string): Uint8Array {
  return encodeLengthPrefixedBytes(textEncoder.encode(value));
}

function encodeLengthPrefixedBytes(value: Uint8Array): Uint8Array {
  const lengthBytes = new Uint8Array(4);
  const view = new DataView(lengthBytes.buffer);
  view.setUint32(0, value.length, false);
  return concatBytes(lengthBytes, value);
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const totalLength = values.reduce((sum, value) => sum + value.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function postJSON<T>(
  url: string,
  body: unknown,
  options: {
    timeoutMs?: number;
    timeoutMessage?: string;
  } = {}
): Promise<T> {
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : HTTP_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw codedError(
        options.timeoutMessage || "The relay request timed out before the Mac responded.",
        "request_timeout"
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw codedError(
      readServerErrorMessage(payload, `Request failed with ${response.status}.`),
      normalizeString(asObject(payload).code)
    );
  }

  return payload as T;
}

function makeRpcError(error: NonNullable<RpcMessage["error"]>): Error {
  return Object.assign(new Error(readServerErrorMessage(error, "RPC request failed.")), {
    code: error.code,
    data: error.data ?? null,
  });
}

function codedError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isCodedError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function isRePairRequiredError(error: unknown): error is Error {
  return isCodedError(error, "re_pair_required");
}
