export interface PairingPayload {
  v: number;
  relay: string;
  sessionId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  expiresAt: number;
}

export interface PhoneIdentityState {
  phoneDeviceId: string;
  phoneIdentityPrivateKey: string;
  phoneIdentityPublicKey: string;
}

export interface TrustedMacRecord {
  macDeviceId: string;
  macIdentityPublicKey: string;
  lastPairedAt: string;
  relayURL?: string | null;
  displayName?: string | null;
  lastResolvedSessionId?: string | null;
  lastResolvedAt?: string | null;
  lastUsedAt?: string | null;
}

export interface PersistedRelaySession {
  relayUrl: string;
  sessionId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  protocolVersion: number;
  lastAppliedBridgeOutboundSeq: number;
  shouldForceQRBootstrapOnNextHandshake: boolean;
}

export interface PersistedState {
  version: 1;
  phoneIdentityState: PhoneIdentityState;
  trustedMacRegistry: Record<string, TrustedMacRecord>;
  lastTrustedMacDeviceId: string | null;
  relaySession: PersistedRelaySession | null;
}

export interface ThreadSummary {
  id: string;
  title: string;
  subtitle: string;
  preview: string;
  cwd: string;
  updatedAt: string | null;
  parentThreadId: string | null;
  agentNickname: string | null;
  agentRole: string | null;
}

export type MessageRole = "user" | "assistant" | "system";
export type MessageKind =
  | "chat"
  | "thinking"
  | "toolActivity"
  | "fileChange"
  | "commandExecution"
  | "subagentAction"
  | "plan";

export interface ConversationMessage {
  id: string;
  threadId: string;
  role: MessageRole;
  kind: MessageKind;
  text: string;
  createdAt: string;
  turnId?: string | null;
  itemId?: string | null;
  isStreaming: boolean;
  deliveryState: "pending" | "confirmed" | "failed";
}

export interface ApprovalRequest {
  id: string;
  requestId: string;
  method: string;
  command: string;
  reason: string;
  threadId: string | null;
  turnId: string | null;
}

export interface ConnectionSummary {
  phase: "idle" | "restoring" | "connecting" | "connected" | "disconnected" | "error";
  secureState:
    | "notPaired"
    | "trustedMac"
    | "handshaking"
    | "encrypted"
    | "reconnecting"
    | "rePairRequired"
    | "updateRequired";
  label: string;
  relayUrl: string;
  macDeviceId: string;
  macName: string;
}

export interface ClientSnapshot {
  connection: ConnectionSummary;
  threads: ThreadSummary[];
  threadListHasMore: boolean;
  threadListNextCursor: string | null;
  activeThreadId: string | null;
  loadingThreadId: string | null;
  messagesByThread: Record<string, ConversationMessage[]>;
  pendingApprovals: ApprovalRequest[];
  trustedMacs: TrustedMacRecord[];
  lastError: string;
  isBusy: boolean;
}

export interface RpcMessage {
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: Record<string, unknown> | null;
  } | null;
}

export interface SecureClientHello {
  kind: "clientHello";
  protocolVersion: number;
  sessionId: string;
  handshakeMode: "qr_bootstrap" | "trusted_reconnect";
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
  phoneEphemeralPublicKey: string;
  clientNonce: string;
}

export interface SecureServerHello {
  kind: "serverHello";
  protocolVersion: number;
  sessionId: string;
  handshakeMode: "qr_bootstrap" | "trusted_reconnect";
  macDeviceId: string;
  macIdentityPublicKey: string;
  macEphemeralPublicKey: string;
  serverNonce: string;
  keyEpoch: number;
  expiresAtForTranscript: number;
  macSignature: string;
  clientNonce?: string;
}

export interface SecureClientAuth {
  kind: "clientAuth";
  sessionId: string;
  phoneDeviceId: string;
  keyEpoch: number;
  phoneSignature: string;
}

export interface SecureReadyMessage {
  kind: "secureReady";
  sessionId: string;
  keyEpoch: number;
  macDeviceId: string;
}

export interface SecureResumeState {
  kind: "resumeState";
  sessionId: string;
  keyEpoch: number;
  lastAppliedBridgeOutboundSeq: number;
}

export interface SecureErrorMessage {
  kind: "secureError";
  code: string;
  message: string;
}

export interface SecureEnvelope {
  kind: "encryptedEnvelope";
  v: number;
  sessionId: string;
  keyEpoch: number;
  sender: "mac" | "iphone";
  counter: number;
  ciphertext: string;
  tag: string;
}

export interface SecureApplicationPayload {
  bridgeOutboundSeq?: number | null;
  payloadText: string;
}

export interface TrustedSessionResolveResponse {
  ok: boolean;
  macDeviceId: string;
  macIdentityPublicKey: string;
  displayName?: string | null;
  sessionId: string;
}

export interface DirectBootstrapResponse {
  ok: boolean;
  v: number;
  sessionId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  displayName?: string | null;
}
