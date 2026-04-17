import type {
  ApprovalRequest,
  ConversationMessage,
  PairingPayload,
  RpcMessage,
  ThreadSummary,
  TrustedMacRecord,
} from "./types";

interface ThreadListPage {
  threads: ThreadSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export const PAIRING_QR_VERSION = 2;
export const SECURE_PROTOCOL_VERSION = 1;
export const SECURE_HANDSHAKE_TAG = "remodex-e2ee-v1";
export const TRUSTED_SESSION_RESOLVE_TAG = "remodex-trusted-session-resolve-v1";

export function parsePairingPayload(raw: string): PairingPayload {
  const parsed = JSON.parse(raw) as Partial<PairingPayload>;
  return validatePairingPayload(parsed);
}

export function validatePairingPayload(value: Partial<PairingPayload>): PairingPayload {
  const relay = normalizeString(value.relay);
  const sessionId = normalizeString(value.sessionId);
  const macDeviceId = normalizeString(value.macDeviceId);
  const macIdentityPublicKey = normalizeString(value.macIdentityPublicKey);
  const expiresAt = Number(value.expiresAt);
  const version = Number(value.v);

  if (!relay || !sessionId || !macDeviceId || !macIdentityPublicKey) {
    throw new Error("The pairing payload is missing required fields.");
  }
  if (version !== PAIRING_QR_VERSION) {
    throw new Error("This pairing payload uses an unsupported version.");
  }
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    throw new Error("This pairing payload has expired. Generate a new one from the bridge.");
  }

  return {
    v: version,
    relay,
    sessionId,
    macDeviceId,
    macIdentityPublicKey,
    expiresAt,
  };
}

export function normalizePairingCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/^RMX1:/, "")
    .replace(/[^A-Z0-9]/g, "");
}

export function buildRelaySocketUrl(relayUrl: string, sessionId: string, role: "mac" | "iphone"): string {
  const url = new URL(`${relayUrl.replace(/\/+$/, "")}/${encodeURIComponent(sessionId)}`);
  url.searchParams.set("role", role);
  return url.toString();
}

export function buildPairingCodeResolveUrl(relayUrl: string): string {
  const url = normalizeRelayHttpUrl(relayUrl);
  url.pathname = `${relayPathPrefix(url.pathname)}/v1/pairing/code/resolve`;
  return url.toString();
}

export function buildTrustedSessionResolveUrl(relayUrl: string): string {
  const url = normalizeRelayHttpUrl(relayUrl);
  url.pathname = `${relayPathPrefix(url.pathname)}/v1/trusted/session/resolve`;
  return url.toString();
}

export function buildSelfHostedBootstrapUrl(relayUrl: string): string {
  const url = normalizeRelayHttpUrl(relayUrl);
  url.pathname = `${relayPathPrefix(url.pathname)}/v1/self-host/bootstrap`;
  return url.toString();
}

export function parseThreadList(result: unknown): ThreadSummary[] {
  return parseThreadListPage(result).threads;
}

export function parseThreadListPage(result: unknown): ThreadListPage {
  const object = asObject(result);
  const page = asArray(object.data) ?? asArray(object.items) ?? asArray(object.threads) ?? [];
  const nextCursor = readThreadListCursor(object);

  const threads = page
    .map((value) => parseThreadSummary(value))
    .filter((value): value is ThreadSummary => value !== null)
    .sort((left, right) => compareThreadDates(left.updatedAt, right.updatedAt));

  return {
    threads,
    nextCursor,
    hasMore: nextCursor != null,
  };
}

export function parseThreadSummary(value: unknown): ThreadSummary | null {
  const object = asObject(value);
  const id = normalizeString(object.id);
  if (!id) {
    return null;
  }

  const title = chooseDisplayTitle(object);
  const preview = normalizeString(object.preview);
  const cwd = normalizeString(object.cwd)
    || normalizeString(object.current_working_directory)
    || normalizeString(object.working_directory);
  const subtitleBits = [
    normalizeString(object.agent_nickname) || normalizeString(readMetadataString(object.metadata, "agent_nickname")),
    normalizeString(object.agent_role) || normalizeString(readMetadataString(object.metadata, "agent_role")),
  ].filter(Boolean);

  return {
    id,
    title,
    subtitle: subtitleBits.join(" · "),
    preview,
    cwd,
    updatedAt: normalizeDateString(
      object.updatedAt ?? object.updated_at ?? object.createdAt ?? object.created_at
    ),
    parentThreadId: normalizeNullableString(
      object.parentThreadId ?? object.parent_thread_id ?? readMetadataString(object.metadata, "parent_thread_id")
    ),
    agentNickname: normalizeNullableString(
      object.agentNickname ?? object.agent_nickname ?? readMetadataString(object.metadata, "agent_nickname")
    ),
    agentRole: normalizeNullableString(
      object.agentRole ?? object.agent_role ?? readMetadataString(object.metadata, "agent_role")
    ),
  };
}

export function parseThreadReadMessages(threadId: string, result: unknown): ConversationMessage[] {
  const resultObject = asObject(result);
  const threadObject = asObject(resultObject.thread);
  const turns = asArray(threadObject.turns) ?? [];
  const baseTimestamp = toTimestamp(threadObject.createdAt ?? threadObject.created_at ?? threadObject.updatedAt) ?? 0;
  let offset = 0;
  const messages: ConversationMessage[] = [];

  for (const turnValue of turns) {
    const turnObject = asObject(turnValue);
    const turnId = normalizeNullableString(turnObject.id);
    const turnTimestamp = toTimestamp(turnObject.createdAt ?? turnObject.created_at ?? turnObject.updatedAt) ?? baseTimestamp;
    const items = asArray(turnObject.items) ?? [];

    for (const itemValue of items) {
      const item = asObject(itemValue);
      const type = normalizeItemType(item.type);
      if (!type) {
        continue;
      }

      const text = decodeItemText(item);
      const createdAt = new Date((toTimestamp(item.createdAt ?? item.created_at ?? item.updatedAt) ?? turnTimestamp) + offset);
      offset += 1;
      const itemId = normalizeNullableString(item.id);

      switch (type) {
        case "usermessage":
          if (text) {
            messages.push(createMessage({
              id: itemId ?? `${threadId}:${turnId ?? "turn"}:user:${messages.length}`,
              threadId,
              role: "user",
              kind: "chat",
              text,
              createdAt,
              turnId,
              itemId,
              isStreaming: false,
              deliveryState: "confirmed",
            }));
          }
          break;
        case "agentmessage":
        case "assistantmessage":
          if (text) {
            messages.push(createMessage({
              id: itemId ?? `${threadId}:${turnId ?? "turn"}:assistant:${messages.length}`,
              threadId,
              role: "assistant",
              kind: "chat",
              text,
              createdAt,
              turnId,
              itemId,
              isStreaming: false,
              deliveryState: "confirmed",
            }));
          }
          break;
        case "message": {
          const role = normalizeItemType(item.role).includes("user") ? "user" : "assistant";
          if (text) {
            messages.push(createMessage({
              id: itemId ?? `${threadId}:${turnId ?? "turn"}:${role}:${messages.length}`,
              threadId,
              role,
              kind: "chat",
              text,
              createdAt,
              turnId,
              itemId,
              isStreaming: false,
              deliveryState: "confirmed",
            }));
          }
          break;
        }
        case "reasoning":
          if (text) {
            messages.push(createMessage({
              id: itemId ?? `${threadId}:${turnId ?? "turn"}:thinking:${messages.length}`,
              threadId,
              role: "system",
              kind: "thinking",
              text,
              createdAt,
              turnId,
              itemId,
              isStreaming: false,
              deliveryState: "confirmed",
            }));
          }
          break;
        case "filechange":
        case "diff":
          if (text) {
            messages.push(createMessage({
              id: itemId ?? `${threadId}:${turnId ?? "turn"}:file:${messages.length}`,
              threadId,
              role: "system",
              kind: "fileChange",
              text,
              createdAt,
              turnId,
              itemId,
              isStreaming: false,
              deliveryState: "confirmed",
            }));
          }
          break;
        case "toolcall":
          if (text) {
            messages.push(createMessage({
              id: itemId ?? `${threadId}:${turnId ?? "turn"}:tool:${messages.length}`,
              threadId,
              role: "system",
              kind: "toolActivity",
              text,
              createdAt,
              turnId,
              itemId,
              isStreaming: false,
              deliveryState: "confirmed",
            }));
          }
          break;
        case "commandexecution":
        case "contextcompaction":
        case "enteredreviewmode":
          if (text) {
            messages.push(createMessage({
              id: itemId ?? `${threadId}:${turnId ?? "turn"}:command:${messages.length}`,
              threadId,
              role: "system",
              kind: "commandExecution",
              text,
              createdAt,
              turnId,
              itemId,
              isStreaming: false,
              deliveryState: "confirmed",
            }));
          }
          break;
        case "plan":
          if (text) {
            messages.push(createMessage({
              id: itemId ?? `${threadId}:${turnId ?? "turn"}:plan:${messages.length}`,
              threadId,
              role: "system",
              kind: "plan",
              text,
              createdAt,
              turnId,
              itemId,
              isStreaming: false,
              deliveryState: "confirmed",
            }));
          }
          break;
        default:
          break;
      }
    }
  }

  return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function parseApprovalRequest(message: RpcMessage): ApprovalRequest | null {
  if (!message.method || message.id == null || !message.method.toLowerCase().includes("requestapproval")) {
    return null;
  }

  const params = asObject(message.params);
  const requestId = stringifyId(message.id);

  return {
    id: requestId,
    requestId,
    method: message.method,
    command: normalizeString(params.command),
    reason: normalizeString(params.reason),
    threadId: normalizeNullableString(params.threadId),
    turnId: normalizeNullableString(params.turnId),
  };
}

export function notificationText(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): string {
  if (depth > 12) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => notificationText(entry, seen, depth + 1))
      .filter(Boolean)
      .join("");
  }

  const object = asObject(value);
  if (seen.has(object)) {
    return "";
  }
  seen.add(object);
  const preferredKeys = [
    "delta",
    "text",
    "message",
    "summary",
    "output_text",
    "outputText",
    "content",
    "output",
  ];

  for (const key of preferredKeys) {
    const resolved = notificationText(object[key], seen, depth + 1);
    if (resolved) {
      return resolved;
    }
  }

  return "";
}

export function resolveThreadIdFromParams(params: unknown): string {
  const object = asObject(params);
  return normalizeString(object.threadId)
    || normalizeString(object.thread_id)
    || normalizeString(asObject(object.thread).id);
}

export function resolveTurnIdFromParams(params: unknown): string {
  const object = asObject(params);
  return normalizeString(object.turnId)
    || normalizeString(object.turn_id)
    || normalizeString(object.id)
    || normalizeString(asObject(object.turn).id);
}

export function readServerErrorMessage(error: unknown, fallback = "Request failed."): string {
  const object = asObject(error);
  return normalizeString(object.message) || fallback;
}

export function preferredTrustedMac(records: TrustedMacRecord[], preferredId: string | null): TrustedMacRecord | null {
  if (preferredId) {
    const preferred = records.find((record) => record.macDeviceId === preferredId);
    if (preferred) {
      return preferred;
    }
  }

  return [...records].sort((left, right) => {
    const leftTime = Date.parse(left.lastUsedAt ?? left.lastPairedAt);
    const rightTime = Date.parse(right.lastUsedAt ?? right.lastPairedAt);
    return rightTime - leftTime;
  })[0] ?? null;
}

export function stringifyId(id: string | number | null | undefined): string {
  if (typeof id === "string") {
    return id;
  }
  if (typeof id === "number") {
    return String(id);
  }
  return "";
}

function normalizeRelayHttpUrl(relayUrl: string): URL {
  const url = new URL(relayUrl);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  return url;
}

function relayPathPrefix(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[segments.length - 1] === "relay") {
    return `/${segments.slice(0, -1).join("/")}`.replace(/\/+$/, "");
  }
  return pathname.replace(/\/+$/, "");
}

function compareThreadDates(left: string | null, right: string | null): number {
  return (Date.parse(right ?? "") || 0) - (Date.parse(left ?? "") || 0);
}

function chooseDisplayTitle(object: Record<string, unknown>): string {
  const cleanedName = normalizeString(object.name);
  const cleanedTitle = normalizeString(object.title);
  const cleanedPreview = normalizeString(object.preview);

  if (cleanedName) {
    return cleanedName;
  }
  if (cleanedTitle && !isGenericPlaceholderTitle(cleanedTitle)) {
    return cleanedTitle;
  }
  if (cleanedPreview) {
    return `${cleanedPreview.charAt(0).toUpperCase()}${cleanedPreview.slice(1)}`;
  }
  return "New Thread";
}

function isGenericPlaceholderTitle(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "conversation" || normalized === "new thread";
}

function normalizeItemType(value: unknown): string {
  return normalizeString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function decodeItemText(item: Record<string, unknown>): string {
  const contentItems = asArray(item.content) ?? [];
  const parts: string[] = [];

  for (const value of contentItems) {
    const object = asObject(value);
    const type = normalizeItemType(object.type);

    if ((type === "text" || type === "inputtext" || type === "outputtext" || type === "message")
      && typeof object.text === "string") {
      const text = object.text.trim();
      if (text) {
        parts.push(text);
      }
      continue;
    }

    if (type === "skill") {
      const skillId = normalizeString(object.id) || normalizeString(object.name);
      if (skillId) {
        parts.push(`$${skillId}`);
      }
      continue;
    }

    const nestedText = normalizeString(asObject(object.data).text);
    if (nestedText) {
      parts.push(nestedText);
    }
  }

  const joined = parts.join("\n").trim();
  if (joined) {
    return joined;
  }

  return normalizeString(item.text) || normalizeString(item.message);
}

function createMessage(message: Omit<ConversationMessage, "createdAt"> & { createdAt: Date }): ConversationMessage {
  return {
    ...message,
    createdAt: message.createdAt.toISOString(),
  };
}

function readMetadataString(metadata: unknown, key: string): string {
  return normalizeString(asObject(metadata)[key]);
}

function readThreadListCursor(value: Record<string, unknown>): string | null {
  const candidate = value.nextCursor ?? value.next_cursor ?? null;
  if (typeof candidate === "string") {
    const normalized = candidate.trim();
    return normalized ? normalized : null;
  }
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return String(candidate);
  }
  return null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized || null;
}

function normalizeDateString(value: unknown): string | null {
  const timestamp = toTimestamp(value);
  return timestamp == null ? null : new Date(timestamp).toISOString();
}

function toTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== "") {
      return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
