import { FeeBumpTransaction, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

export type TransactionStatus = "SUCCESS" | "FAILED" | "NOT_FOUND" | "PENDING" | string;

export type SimulationResult = {
  restorePreamble?: unknown;
  error?: string;
  minResourceFee?: string | number | bigint;
  transactionData?: unknown;
};

export type SubmissionResult = {
  status: string;
  hash?: string;
  errorResult?: unknown;
};

export type TransactionResult<T> = {
  status: TransactionStatus;
  latestLedger?: number;
  result?: T;
};

export interface TransactionRpc<Tx, Sim extends SimulationResult, Send extends SubmissionResult, Result> {
  simulateTransaction(transaction: Tx): Promise<Sim>;
  sendTransaction(transaction: Tx): Promise<Send>;
  getTransaction(hash: string): Promise<TransactionResult<Result>>;
}

export type TransactionExecutionOptions<Tx, Sim extends SimulationResult, Send extends SubmissionResult, Result> = {
  rpc: TransactionRpc<Tx, Sim, Send, Result>;
  transaction: Tx;
  sign(transaction: Tx): Promise<Tx> | Tx;
  assemble(transaction: Tx, simulation: Sim): Tx;
  restore?(preamble: NonNullable<Sim["restorePreamble"]>): Promise<void>;
  feeBump?(transaction: Tx, sendResult: Send): Promise<Tx> | Tx;
  shouldFeeBump?(sendResult: Send): boolean;
  maxFeeBumpAttempts?: number;
  maxPollAttempts?: number;
  initialPollDelayMs?: number;
  maxPollDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  /**
   * Idempotency key for checkout submissions. When provided, retries reuse the
   * same signed transaction hash instead of submitting a second transaction.
   */
  idempotencyKey?: string;
  /**
   * Previously observed transaction hash for this idempotency key. When set,
   * execution skips signing/submission and polls for finality of this hash.
   */
  transactionHash?: string;
  /** Called as soon as a transaction hash is known (submission or reuse). */
  onTransactionHash?(hash: string): void;
};

export type SorobanTransactionErrorDetails = {
  hash?: string;
  idempotencyKey?: string;
  simulation?: SimulationResult;
  submission?: SubmissionResult;
  [key: string]: unknown;
};

export class SorobanTransactionError extends Error {
  readonly hash?: string;
  readonly idempotencyKey?: string;

  constructor(message: string, readonly details?: SorobanTransactionErrorDetails) {
    super(message);
    this.name = "SorobanTransactionError";
    this.hash = details?.hash;
    this.idempotencyKey = details?.idempotencyKey;
  }
}

/**
 * Estimates the Soroban network resource fee (in stroops) from a simulation
 * result so callers can display it in an itemized checkout breakdown.
 */
export function estimateSorobanResourceFee(simulation: SimulationResult | undefined | null): bigint {
  const raw = simulation?.minResourceFee;
  if (raw === undefined || raw === null) return 0n;
  if (typeof raw === "bigint") return raw < 0n ? 0n : raw;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return 0n;
    return BigInt(Math.trunc(raw));
  }
  const trimmed = raw.trim();
  if (trimmed === "") return 0n;
  try {
    const parsed = BigInt(trimmed);
    return parsed < 0n ? 0n : parsed;
  } catch {
    return 0n;
  }
}

export function buildFeeBumpTransaction(
  transaction: Transaction,
  feeSource: string,
  baseFee: string,
  networkPassphrase: string,
): FeeBumpTransaction {
  return TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    baseFee,
    transaction,
    networkPassphrase,
  );
}

export async function executeSorobanTransaction<
  Tx,
  Sim extends SimulationResult,
  Send extends SubmissionResult,
  Result,
>(options: TransactionExecutionOptions<Tx, Sim, Send, Result>): Promise<TransactionResult<Result>> {
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve, reject) => {
    const timer = (globalThis as typeof globalThis & {
      setTimeout?: (callback: () => void, delay: number) => unknown;
    }).setTimeout;
    if (timer === undefined) {
      reject(new Error("A sleep implementation is required in this runtime"));
      return;
    }
    timer(resolve, milliseconds);
  }));
  const maxPollAttempts = options.maxPollAttempts ?? 8;
  const maxFeeBumpAttempts = options.maxFeeBumpAttempts ?? 1;
  const idempotencyKey = options.idempotencyKey;
  let transaction = options.transaction;
  let transactionHash = options.transactionHash;

  if (transactionHash !== undefined) {
    options.onTransactionHash?.(transactionHash);
  } else {
    let simulation = await options.rpc.simulateTransaction(transaction);
    if (simulation.error !== undefined) {
      throw new SorobanTransactionError(`Soroban simulation failed: ${simulation.error}`, {
        simulation,
        idempotencyKey,
        hash: transactionHash,
      });
    }
    const restorePreamble = simulation.restorePreamble;
    if (restorePreamble !== undefined && restorePreamble !== null) {
      if (options.restore === undefined) {
        throw new SorobanTransactionError("Archived ledger entries require a RestoreFootprintOp callback", {
          simulation,
          idempotencyKey,
          hash: transactionHash,
        });
      }
      await options.restore(restorePreamble as NonNullable<Sim["restorePreamble"]>);
      simulation = await options.rpc.simulateTransaction(transaction);
      if (simulation.error !== undefined || simulation.restorePreamble !== undefined) {
        throw new SorobanTransactionError("Soroban simulation still requires restoration or failed after restore", {
          simulation,
          idempotencyKey,
          hash: transactionHash,
        });
      }
    }

    transaction = await options.sign(options.assemble(transaction, simulation));
    let sendResult: Send | undefined;
    for (let attempt = 0; attempt <= maxFeeBumpAttempts; attempt += 1) {
      sendResult = await options.rpc.sendTransaction(transaction);
      if (sendResult.hash !== undefined) {
        transactionHash = sendResult.hash;
        options.onTransactionHash?.(sendResult.hash);
      }
      if (sendResult.status === "PENDING" && sendResult.hash !== undefined) break;
      if (
        attempt === maxFeeBumpAttempts ||
        options.feeBump === undefined ||
        options.shouldFeeBump?.(sendResult) !== true
      ) {
        throw new SorobanTransactionError(`Soroban transaction submission failed: ${sendResult.status}`, {
          submission: sendResult,
          idempotencyKey,
          hash: transactionHash,
        });
      }
      transaction = await options.sign(await options.feeBump(transaction, sendResult));
    }

    if (transactionHash === undefined) {
      throw new SorobanTransactionError("Soroban RPC accepted no transaction hash", {
        submission: sendResult,
        idempotencyKey,
      });
    }
  }

  let delay = options.initialPollDelayMs ?? 500;
  const maxDelay = options.maxPollDelayMs ?? 8_000;
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    const result = await options.rpc.getTransaction(transactionHash);
    if (result.status === "SUCCESS") return result;
    if (result.status === "FAILED") {
      throw new SorobanTransactionError("Soroban transaction failed on-ledger", {
        result,
        idempotencyKey,
        hash: transactionHash,
      });
    }
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelay);
  }

  throw new SorobanTransactionError(`Timed out waiting for transaction ${transactionHash}`, {
    hash: transactionHash,
    idempotencyKey,
  });
}