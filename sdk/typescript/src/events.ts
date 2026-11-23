import { scValToNative, xdr } from "@stellar/stellar-sdk";

export type SorobanEventRecord = {
  id: string;
  pagingToken?: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId?: string | { toString(): string };
  topic: xdr.ScVal[];
  value: xdr.ScVal;
};

export type ParsedContractEvent<T = Record<string, unknown>> = {
  id: string;
  contractId?: string;
  ledger: number;
  ledgerClosedAt: string;
  name: string;
  topics: unknown[];
  data: T;
};

export function parseContractEvent<T = Record<string, unknown>>(
  event: SorobanEventRecord,
): ParsedContractEvent<T> {
  const decodedTopics = event.topic.map((topic) => scValToNative(topic));
  const eventName = decodedTopics[0];
  if (typeof eventName !== "string") {
    throw new TypeError("Soroban contract event is missing its event-name topic");
  }

  const decodedValue: unknown = scValToNative(event.value);
  const data = decodedValue instanceof Map
    ? Object.fromEntries(decodedValue.entries())
    : decodedValue;

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError(`Soroban event ${eventName} has a non-struct value`);
  }

  return {
    id: event.id,
    contractId: event.contractId?.toString(),
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    name: eventName,
    topics: decodedTopics.slice(1),
    data: data as T,
  };
}

export type ContractEventFilter = {
  type?: "contract" | "system" | "diagnostic";
  contractIds?: string[];
  topics?: string[][];
};

/**
 * Payment lifecycle event names emitted by the `Payment` contract.
 */
export const PAYMENT_EVENT_NAMES = [
  "PaymentCreated",
  "PaymentCompleted",
  "PaymentRefunded",
] as const;

export type PaymentEventName = (typeof PAYMENT_EVENT_NAMES)[number];

/**
 * Decoded `PaymentMemo` metadata attached to a payment event.
 */
export type PaymentMemo = {
  memoType?: string;
  memo?: string;
  [key: string]: unknown;
};

/**
 * Shared shape for all payment lifecycle events. Monetary amounts are
 * decoded as `bigint` (i128) so consumers never lose precision by routing
 * them through JavaScript `Number`.
 */
export type PaymentEventBase = {
  paymentId: string;
  customer: string;
  token: string;
  amount: bigint;
  status: string;
  memo?: PaymentMemo;
};

export type PaymentCreatedEvent = PaymentEventBase & {
  name: "PaymentCreated";
};

export type PaymentCompletedEvent = PaymentEventBase & {
  name: "PaymentCompleted";
};

export type PaymentRefundedEvent = PaymentEventBase & {
  name: "PaymentRefunded";
};

export type PaymentEvent =
  | PaymentCreatedEvent
  | PaymentCompletedEvent
  | PaymentRefundedEvent;

export function isPaymentEventName(value: unknown): value is PaymentEventName {
  return (
    typeof value === "string" &&
    (PAYMENT_EVENT_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Coerce an i128-like value into a `bigint` without ever passing through
 * `Number`. Accepts bigint, integer strings, and objects exposing a
 * `toString()` (e.g. `i128` wrappers from the SDK).
 */
export function toBigIntAmount(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new TypeError(`Cannot decode i128 amount from string "${value}"`);
    }
    return BigInt(trimmed);
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError(`Cannot decode i128 amount from non-integer ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `Refusing to decode i128 amount ${value}: exceeds Number.MAX_SAFE_INTEGER`,
      );
    }
    return BigInt(value);
  }
  if (value !== null && typeof value === "object") {
    const asString = value.toString();
    if (asString !== "[object Object]") {
      return toBigIntAmount(asString);
    }
  }
  throw new TypeError(`Cannot decode i128 amount from ${typeof value}`);
}

function pickField(
  data: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (data[key] !== undefined && data[key] !== null) {
      return data[key];
    }
  }
  return undefined;
}

function asAddress(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value !== null && typeof value === "object") {
    return value.toString();
  }
  throw new TypeError("Payment event is missing an address field");
}

function decodeMemo(value: unknown): PaymentMemo | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value instanceof Map) {
    return Object.fromEntries(value.entries()) as PaymentMemo;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as PaymentMemo;
  }
  return { memo: String(value) };
}

/**
 * Normalize a parsed contract event into a strongly-typed payment event.
 * Returns `undefined` for unrelated events or malformed payloads.
 */
export function parsePaymentEvent(
  event: ParsedContractEvent<Record<string, unknown>>,
): PaymentEvent | undefined {
  if (!isPaymentEventName(event.name)) {
    return undefined;
  }

  const data = event.data ?? {};
  try {
    const paymentId = pickField(data, ["payment_id", "paymentId", "id"]);
    const customer = pickField(data, ["customer", "payer", "from"]);
    const token = pickField(data, ["token", "asset", "token_address"]);
    const amount = pickField(data, ["amount", "net_amount", "value"]);
    const status = pickField(data, ["status", "state"]);

    if (paymentId === undefined || customer === undefined || token === undefined) {
      return undefined;
    }
    if (amount === undefined) {
      return undefined;
    }

    const base: PaymentEventBase = {
      paymentId: String(paymentId),
      customer: asAddress(customer),
      token: asAddress(token),
      amount: toBigIntAmount(amount),
      status: status === undefined ? event.name.replace("Payment", "") : String(status),
      memo: decodeMemo(pickField(data, ["memo", "metadata"])),
    };

    return { ...base, name: event.name } as PaymentEvent;
  } catch {
    return undefined;
  }
}

/**
 * Filter and parse payment lifecycle events out of a raw Soroban event batch.
 */
export function parsePaymentEvents(
  events: SorobanEventRecord[],
): PaymentEvent[] {
  const parsed: PaymentEvent[] = [];
  for (const event of events) {
    let contractEvent: ParsedContractEvent<Record<string, unknown>>;
    try {
      contractEvent = parseContractEvent<Record<string, unknown>>(event);
    } catch {
      continue;
    }
    const paymentEvent = parsePaymentEvent(contractEvent);
    if (paymentEvent) {
      parsed.push(paymentEvent);
    }
  }
  return parsed;
}

/**
 * Build a Soroban topic filter matching the payment lifecycle events for a
 * given Payment contract.
 */
export function paymentEventFilter(contractId: string): ContractEventFilter {
  return {
    type: "contract",
    contractIds: [contractId],
    topics: [[...PAYMENT_EVENT_NAMES]],
  };
}

/**
 * Subscribe to real-time payment events by wrapping `pollContractEvents` with
 * a Payment-contract topic filter. The callback is invoked once per parsed
 * payment event; amounts are always `bigint`.
 */
export async function subscribePaymentEvents(options: {
  rpc: EventRpc;
  checkpoints: EventCheckpointStore;
  contractId: string;
  startLedger?: number;
  limit?: number;
  onEvent(event: PaymentEvent): Promise<void> | void;
}): Promise<{ cursor?: string; latestLedger: number; eventsProcessed: number }> {
  let eventsProcessed = 0;
  const result = await pollContractEvents<Record<string, unknown>>({
    rpc: options.rpc,
    checkpoints: options.checkpoints,
    filters: [paymentEventFilter(options.contractId)],
    startLedger: options.startLedger,
    limit: options.limit,
    onEvent: async (event) => {
      const paymentEvent = parsePaymentEvent(event);
      if (paymentEvent) {
        eventsProcessed += 1;
        await options.onEvent(paymentEvent);
      }
    },
  });

  return { ...result, eventsProcessed };
}

export type GetEventsRequest = {
  startLedger?: number;
  endLedger?: number;
  cursor?: string;
  limit?: number;
  filters: ContractEventFilter[];
};

export type GetEventsResponse = {
  events: SorobanEventRecord[];
  cursor: string;
  latestLedger: number;
};

export interface EventRpc {
  getEvents(request: GetEventsRequest): Promise<GetEventsResponse>;
}

export interface EventCheckpointStore {
  get(): Promise<string | undefined>;
  set(cursor: string): Promise<void>;
}

export async function pollContractEvents<T = Record<string, unknown>>(options: {
  rpc: EventRpc;
  checkpoints: EventCheckpointStore;
  filters: ContractEventFilter[];
  startLedger?: number;
  limit?: number;
  onEvent(event: ParsedContractEvent<T>): Promise<void> | void;
}): Promise<{ cursor?: string; latestLedger: number; eventsProcessed: number }> {
  const cursor = await options.checkpoints.get();
  const response = await options.rpc.getEvents({
    startLedger: options.startLedger,
    filters: options.filters,
    cursor,
    limit: options.limit,
  });

  for (const event of response.events) {
    await options.onEvent(parseContractEvent<T>(event));
  }

  const nextCursor = response.cursor || response.events.at(-1)?.pagingToken || cursor;
  if (nextCursor !== undefined && nextCursor !== cursor) {
    await options.checkpoints.set(nextCursor);
  }

  return {
    cursor: nextCursor,
    latestLedger: response.latestLedger,
    eventsProcessed: response.events.length,
  };
}