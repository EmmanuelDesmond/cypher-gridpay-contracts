/**
 * LiveStreamCounter
 *
 * Real-time streaming micro-payment channel card with live flow-rate badge,
 * dual-segment progress bar (Claimed | Accrued | Remaining), runway indicator
 * with threshold states, and a quick top-up micro-interaction.
 *
 * Designed to eliminate horizontal numeric jitter via tabular-nums + monospace
 * + fixed-width containers, and to provide a clean reduced-motion alternative
 * (periodic 1.5s updates, static icons, no continuous animation).
 *
 * Spec: docs/ux/streaming-channels-ux.md
 * Issue: #416
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REDUCED_MOTION_TICK_MS = 1500;

/** Interval at which the interpolated value is reconciled with on-chain state. */
const RECONCILE_INTERVAL_MS = 15_000;

/** Fixed-point scale for BigInt interpolation (7 decimal places, Stellar stroop-like). */
const FIXED_POINT_SCALE = 10_000_000n;
const FIXED_POINT_SCALE_NUM = 10_000_000;

/** Channel accent palette (color-blind safe Okabe-Ito). */
const COLOR = {
  accent: '#0072B2', // claimed / safe / neutral
  accrued: '#56B4E9', // accrued (claimable now) - lighter sky blue
  remaining: '#A9C7E0', // remaining buffer - lightest
  amberStart: '#F0E442',
  amberEnd: '#E69F00',
  red: '#D55E00', // circuit breaker / depleted
  amberText: '#5A4400', // dark text over yellow for AA contrast
  axis: '#5A6478',
  empty: '#8A93A6',
  cardBg: '#FFFFFF',
  border: 'rgba(0,0,0,0.1)',
  divider: 'rgba(0,0,0,0.08)',
} as const;

const MONO_STACK =
  'ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelStatus = 'live' | 'paused' | 'depleted' | 'closed';

export interface LiveStreamCounterProps {
  /** Channel identifier, e.g. "CH-7421" */
  channelId: string;
  /** Human label for the channel, e.g. "Energy Feed" */
  channelLabel: string;
  /** Current flow rate in USDC per minute */
  flowRateUsdcPerMin: number;
  /** Energy conversion factor (kWh per USDC); used to derive kWh/hr */
  kwhPerUsdc?: number;
  /** Total funds deposited into the channel (USDC) */
  totalDeposit: number;
  /** Value already claimed/settled (USDC) */
  claimed: number;
  /** Value accrued and claimable now (USDC) */
  accrued: number;
  /**
   * Ledger timestamp (ms since epoch) at which `accrued` was last observed
   * on-chain. Used as the interpolation anchor. Defaults to mount time.
   */
  lastLedgerTimestamp?: number;
  /**
   * Optional explicit per-second rate (USDC). When omitted it is derived from
   * `flowRateUsdcPerMin`. Prefer passing the on-chain rate for accuracy.
   */
  ratePerSecond?: number;
  /**
   * Maximum funded deposit (USDC) used to clamp interpolated display values.
   * Defaults to `totalDeposit`.
   */
  depositCap?: number;
  /**
   * Called every 15s to fetch fresh on-chain state for reconciliation.
   * Should resolve to the latest observed values.
   */
  onReconcile?: () => Promise<{
    accrued: number;
    claimed: number;
    lastLedgerTimestamp: number;
  }> | void;
  /** Current channel status */
  status?: ChannelStatus;
  /** Called with the top-up amount when a quick top-up pill is used */
  onTopUp?: (amountUsdc: number) => void | Promise<void>;
  /** Called when Mutual Close is initiated */
  onMutualClose?: () => void;
  /** Called when Unilateral Close is initiated */
  onUnilateralClose?: () => void;
  /** Whether the counterparty signature is available for mutual close */
  counterpartyResponsive?: boolean;
  /** Manual reduced-motion override (defaults to media query) */
  forceReducedMotion?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUsdc(v: number): string {
  return v.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatFlowRate(v: number): string {
  return v.toFixed(4);
}

function formatKwhPerHr(usdcPerMin: number, kwhPerUsdc: number): string {
  const kwhPerHr = usdcPerMin * 60 * kwhPerUsdc;
  return kwhPerHr.toFixed(1);
}

/** Estimated runway in hours given remaining buffer and flow rate. */
function computeRunwayHours(remaining: number, flowRatePerMin: number): number {
  if (flowRatePerMin <= 0) return Infinity; // paused → no depletion
  return remaining / (flowRatePerMin * 60);
}

function formatRunway(hours: number): string {
  if (hours === Infinity || Number.isNaN(hours)) return 'Paused';
  if (hours > 999) return '>999h';
  if (hours <= 0) return 'Depleted';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

type RunwayState = 'neutral' | 'amber' | 'red' | 'depleted' | 'paused';

function runwayState(
  hours: number,
  status: ChannelStatus,
): { state: RunwayState; label: string; color: string; textColor: string } {
  if (status === 'paused' && hours === Infinity) {
    return {
      state: 'paused',
      label: 'Paused — no depletion while idle',
      color: COLOR.axis,
      textColor: '#fff',
    };
  }
  if (hours <= 0 || status === 'depleted') {
    return {
      state: 'depleted',
      label: 'Depleted — Top up to resume',
      color: COLOR.red,
      textColor: '#fff',
    };
  }
  if (hours <= 4) {
    return {
      state: 'red',
      label: 'red < 4h',
      color: COLOR.red,
      textColor: '#fff',
    };
  }
  if (hours <= 24) {
    return {
      state: 'amber',
      label: 'amber < 24h',
      color: COLOR.amberStart,
      textColor: COLOR.amberText,
    };
  }
  return {
    state: 'neutral',
    label: 'Healthy',
    color: COLOR.accent,
    textColor: '#fff',
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// ---------------------------------------------------------------------------
// BigInt fixed-point interpolation
// ---------------------------------------------------------------------------

/** Convert a USDC number to scaled BigInt fixed-point. */
export function toFixedPoint(usdc: number): bigint {
  if (!Number.isFinite(usdc) || usdc <= 0) return 0n;
  return BigInt(Math.round(usdc * FIXED_POINT_SCALE_NUM));
}

/** Convert scaled BigInt fixed-point back to a USDC number. */
export function fromFixedPoint(fp: bigint): number {
  return Number(fp) / FIXED_POINT_SCALE_NUM;
}

/**
 * Compute the interpolated accrued amount in scaled fixed-point.
 *
 * accrued = anchorAccrued + ratePerSecond * elapsedSeconds
 * clamped to [0, depositCap].
 *
 * All arithmetic is BigInt to avoid floating-point drift on long streams.
 */
export function interpolateAccruedFixedPoint(params: {
  anchorAccrued: number;
  ratePerSecond: number;
  elapsedMs: number;
  depositCap: number;
}): bigint {
  const { anchorAccrued, ratePerSecond, elapsedMs, depositCap } = params;
  const anchorFp = toFixedPoint(anchorAccrued);
  const rateFp = toFixedPoint(ratePerSecond);
  const capFp = toFixedPoint(depositCap);

  if (elapsedMs <= 0 || rateFp <= 0n) {
    return anchorFp > capFp ? capFp : anchorFp;
  }

  // elapsedMs is integer ms; multiply rate (per second) by ms then divide by 1000.
  const elapsedMsBig = BigInt(Math.max(0, Math.floor(elapsedMs)));
  const deltaFp = (rateFp * elapsedMsBig) / 1000n;
  const raw = anchorFp + deltaFp;

  if (raw < 0n) return 0n;
  if (raw > capFp) return capFp;
  return raw;
}

/** Clamp a scaled fixed-point value to [0, depositCap]. */
export function clampToDeposit(valueFp: bigint, depositCap: number): bigint {
  const capFp = toFixedPoint(depositCap);
  if (valueFp < 0n) return 0n;
  if (valueFp > capFp) return capFp;
  return valueFp;
}

// ---------------------------------------------------------------------------
// Live ticker hook
// ---------------------------------------------------------------------------

/**
 * Continuously advances the `accrued` value based on the flow rate.
 *
 * Interpolation is anchored to `(lastLedgerTimestamp, anchorAccrued)` and
 * computed with BigInt fixed-point math, then clamped to `depositCap`.
 *
 * - Uses requestAnimationFrame when motion is allowed.
 * - Uses a 1.5s setInterval when reduced motion is active.
 * - Pauses the loop entirely when `document.visibilityState === 'hidden'`.
 * - Reconciles with on-chain state every 15s via `onReconcile`.
 */
function useLiveAccrual(
  baseAccrued: number,
  ratePerSecond: number,
  status: ChannelStatus,
  reducedMotion: boolean,
  depositCap: number,
  lastLedgerTimestamp: number,
  onReconcile?: LiveStreamCounterProps['onReconcile'],
): number {
  const [accrued, setAccrued] = useState(baseAccrued);

  // Anchor state — mutated by reconciliation and prop changes.
  const anchorAccruedRef = useRef<number>(baseAccrued);
  const anchorTsRef = useRef<number>(lastLedgerTimestamp);
  const depositCapRef = useRef<number>(depositCap);
  const rateRef = useRef<number>(ratePerSecond);
  const onReconcileRef = useRef(onReconcile);

  useEffect(() => {
    onReconcileRef.current = onReconcile;
  }, [onReconcile]);

  // Re-anchor when the on-chain base value / timestamp changes.
  useEffect(() => {
    anchorAccruedRef.current = baseAccrued;
    anchorTsRef.current = lastLedgerTimestamp;
    depositCapRef.current = depositCap;
    rateRef.current = ratePerSecond;
    setAccrued(baseAccrued);
  }, [baseAccrued, lastLedgerTimestamp, depositCap, ratePerSecond]);

  // Visibility tracking — pause animation when tab is hidden.
  const [hidden, setHidden] = useState<boolean>(
    typeof document !== 'undefined' && document.visibilityState === 'hidden',
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handler = () => {
      const isHidden = document.visibilityState === 'hidden';
      setHidden(isHidden);
      if (!isHidden) {
        // Re-anchor to now so we don't "catch up" for the hidden period.
        anchorAccruedRef.current = fromFixedPoint(
          clampToDeposit(
            interpolateAccruedFixedPoint({
              anchorAccrued: anchorAccruedRef.current,
              ratePerSecond: rateRef.current,
              elapsedMs: Date.now() - anchorTsRef.current,
              depositCap: depositCapRef.current,
            }),
            depositCapRef.current,
          ),
        );
        anchorTsRef.current = Date.now();
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // Animation loop.
  useEffect(() => {
    if (status !== 'live' || ratePerSecond <= 0 || hidden) return;

    const compute = () => {
      const elapsedMs = Date.now() - anchorTsRef.current;
      const fp = interpolateAccruedFixedPoint({
        anchorAccrued: anchorAccruedRef.current,
        ratePerSecond: rateRef.current,
        elapsedMs,
        depositCap: depositCapRef.current,
      });
      return fromFixedPoint(clampToDeposit(fp, depositCapRef.current));
    };

    if (reducedMotion) {
      const id = setInterval(() => {
        setAccrued(compute());
      }, REDUCED_MOTION_TICK_MS);
      return () => clearInterval(id);
    }

    let raf = 0;
    const step = () => {
      setAccrued(compute());
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ratePerSecond, status, reducedMotion, hidden]);

  // Reconcile with on-chain state every 15s.
  useEffect(() => {
    if (!onReconcileRef.current) return;
    const id = setInterval(async () => {
      try {
        const next = await onReconcileRef.current?.();
        if (!next) return;
        anchorAccruedRef.current = next.accrued;
        anchorTsRef.current = next.lastLedgerTimestamp;
        setAccrued(next.accrued);
      } catch {
        // Reconciliation failures are non-fatal; keep interpolating.
      }
    }, RECONCILE_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return accrued;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface FlowRateBadgeProps {
  flowRateUsdcPerMin: number;
  kwhPerUsdc: number;
  status: ChannelStatus;
  reducedMotion: boolean;
}

function FlowRateBadge({
  flowRateUsdcPerMin,
  kwhPerUsdc,
  status,
  reducedMotion,
}: FlowRateBadgeProps) {
  const isLive = status === 'live';
  const isPaused = status === 'paused';
  const isDepleted = status === 'depleted';

  const rateText = isPaused
    ? '⏸ Paused'
    : isDepleted
      ? '0.0000 USDC/min'
      : `${formatFlowRate(flowRateUsdcPerMin)} USDC/min`;

  const kwhText =
    isPaused || isDepleted
      ? '0.0 kWh/hr'
      : `~${formatKwhPerHr(flowRateUsdcPerMin, kwhPerUsdc)} kWh/hr`;

  return (
    <div
      role="status"
      aria-label={
        isLive
          ? `Streaming at ${formatFlowRate(flowRateUsdcPerMin)} USDC per minute, approximately ${formatKwhPerHr(flowRateUsdcPerMin, kwhPerUsdc)} kilowatt-hours per hour.`
          : isPaused
            ? 'Stream paused.'
            : 'Stream depleted.'
      }
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 14,
      }}
    >
      {/* Flow arrow */}
      <span aria-hidden="true" style={{ fontSize: 16, color: isLive ? COLOR.accent : COLOR.empty }}>
        ⟶
      </span>

      {/* Rate — fixed width, tabular-nums, monospace */}
      <span
        style={{
          fontFamily: MONO_STACK,
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'right',
          minWidth: '12ch',
          display: 'inline-block',
          whiteSpace: 'pre',
          color: isLive ? '#1C2333' : COLOR.empty,
          fontWeight: 600,
        }}
      >
        {rateText}
      </span>

      <span style={{ color: COLOR.axis }}>·</span>

      <span
        style={{
          fontFamily: MONO_STACK,
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'right',
          minWidth: '10ch',
          display: 'inline-block',
          whiteSpace: 'pre',
          color: isLive ? '#1C2333' : COLOR.empty,
        }}
      >
        {kwhText}
      </span>

      {/* Live status dot */}
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          marginLeft: 'auto',
          fontSize: 12,
          fontWeight: 600,
          color: isLive ? COLOR.accent : isPaused ? COLOR.empty : COLOR.red,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: isLive ? COLOR.accent : isPaused ? COLOR.empty : COLOR.red,
            display: 'inline-block',
            ...(isLive && !reducedMotion
              ? { animation: 'ls-pulse 1.6s ease-in-out infinite' }
              : {}),
          }}
        />
        {isLive ? 'Live' : isPaused ? 'Paused' : 'Depleted'}
      </span>

      <style>{`
        @keyframes ls-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

interface ProgressBarProps {
  totalDeposit: number;
  claimed: number;
  accrued: number;
  reducedMotion: boolean;
}

function ProgressBar({
  totalDeposit,
  claimed,
  accrued,
  reducedMotion,
}: ProgressBarProps) {
  const safeTotal = totalDeposit > 0 ? totalDeposit : 1;
  const claimedPct = Math.min(100, (claimed / safeTotal) * 100);
  const accruedPct = Math.min(100 - claimedPct, (accrued / safeTotal) * 100);
  const remainingPct = Math.max(0, 100 - claimedPct - accruedPct);

  return (
    <div>
      {/* Main track: Claimed + Accrued */}
      <div
        role="progressbar"
        aria-valuenow={Math.round(accruedPct + claimedPct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Streaming progress: claimed ${formatUsdc(claimed)} USDC, accrued claimable now ${formatUsdc(accrued)} USDC, remaining buffer ${formatUsdc(Math.max(0, totalDeposit - claimed - accrued))} USDC.`}
        style={{
          position: 'relative',
          height: 22,
          borderRadius: 4,
          background: '#EEF0F4',
          overflow: 'hidden',
          marginBottom: 4,
        }}
      >
        {/* Claimed segment */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            height: '100%',
            width: `${claimedPct}%`,
            background: COLOR.accent,
            transition: reducedMotion ? 'width 200ms ease' : 'width 100ms linear',
          }}
        />
        {/* Accrued segment — hatched/stippled lighter fill */}
        <div
          style={{
            position: 'absolute',
            left: `${claimedPct}%`,
            top: 0,
            height: '100%',
            width: `${accruedPct}%`,
            background: `repeating-linear-gradient(135deg, ${COLOR.accrued}, ${COLOR.accrued} 4px, ${COLOR.accent} 4px, ${COLOR.accent} 6px)`,
            opacity: 0.85,
            transition: reducedMotion ? 'width 200ms ease, left 200ms ease' : 'width 100ms linear, left 100ms linear',
          }}
        />
      </div>

      {/* Companion remaining buffer bar */}
      <div
        style={{
          position: 'relative',
          height: 8,
          borderRadius: 3,
          background: '#EEF0F4',
          overflow: 'hidden',
          marginTop: 2,
        }}
        aria-hidden="true"
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            height: '100%',
            width: `${remainingPct}%`,
            background: `repeating-linear-gradient(90deg, ${COLOR.remaining}, ${COLOR.remaining} 3px, transparent 3px, transparent 6px)`,
            transition: reducedMotion ? 'width 200ms ease' : 'width 100ms linear',
          }}
        />
      </div>

      {/* Segment labels — tabular-nums, outside the bar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px 12px',
          marginTop: 6,
          fontSize: 12,
          color: COLOR.axis,
        }}
      >
        <SegmentLabel color={COLOR.accent} label="Claimed" value={formatUsdc(claimed)} />
        <SegmentLabel color={COLOR.accrued} label="Accrued (now)" value={formatUsdc(accrued)} />
        <SegmentLabel
          color={COLOR.remaining}
          label="Remaining"
          value={formatUsdc(Math.max(0, totalDeposit - claimed - accrued))}
        />
      </div>
    </div>
  );
}

function SegmentLabel({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: string;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span
        aria-hidden="true"
        style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }}
      />
      <span>{label}</span>
      <span
        style={{
          fontFamily: MONO_STACK,
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'right',
          minWidth: '7ch',
          display: 'inline-block',
          whiteSpace: 'pre',
          color: '#1C2333',
          fontWeight: 600,
        }}
      >
        {value}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Runway indicator
// ---------------------------------------------------------------------------

interface RunwayIndicatorProps {
  runwayHours: number;
  state: RunwayState;
  label: string;
  color: string;
  textColor: string;
  reducedMotion: boolean;
}

function RunwayIndicator({
  runwayHours,
  state,
  label,
  color,
  textColor,
  reducedMotion,
}: RunwayIndicatorProps) {
  const showPulse = state === 'red' && !reducedMotion;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
      <span aria-hidden="true" style={{ fontSize: 15, color: COLOR.axis }}>
        ⏱
      </span>
      <span style={{ fontSize: 13, color: COLOR.axis }}>Runway:</span>
      <span
        aria-live="polite"
        role="img"
        aria-label={`Runway ${formatRunway(runwayHours)}, state ${label}`}
        style={{
          fontFamily: MONO_STACK,
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'right',
          minWidth: '9ch',
          display: 'inline-block',
          whiteSpace: 'pre',
          fontWeight: 600,
          color: state === 'neutral' || state === 'paused' ? '#1C2333' : color,
        }}
      >
        {formatRunway(runwayHours)}
      </span>
      <span
        role="img"
        aria-label={label}
        style={{
          fontSize: 12,
          fontWeight: 600,
          padding: '2px 8px',
          borderRadius: 999,
          background: color,
          color: textColor,
          transition: 'background 400ms ease, color 400ms ease',
          ...(showPulse
            ? { animation: 'ls-runway-pulse 2s ease-in-out infinite' }
            : {}),
        }}
      >
        {label}
      </span>
      {showPulse && (
        <style>{`
          @keyframes ls-runway-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(213, 94, 0, 0.4); }
            50% { box-shadow: 0 0 0 4px rgba(213, 94, 0, 0); }
          }
        `}</style>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick top-up pill
// ---------------------------------------------------------------------------

interface TopUpPillProps {
  onTopUp: (amount: number) => void;
  reducedMotion: boolean;
  emphasized: boolean;
}

const PRESETS = [10, 50];

function TopUpPill({ onTopUp, reducedMotion, emphasized }: TopUpPillProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customVal, setCustomVal] = useState('');
  const [successKey, setSuccessKey] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close popover on outside click / Esc
  useEffect(() => {
    if (!customOpen) return;
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setCustomOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCustomOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [customOpen]);

  const handlePreset = async (amount: number) => {
    try {
      await onTopUp(amount);
      setError(null);
      setSuccessKey(amount);
      setTimeout(() => setSuccessKey(null), reducedMotion ? 1500 : 1200);
    } catch {
      setError('Insufficient balance for top-up.');
      if (!reducedMotion) {
        setShake(true);
        setTimeout(() => setShake(false), 200);
      }
    }
  };

  const handleCustomConfirm = async () => {
    const amount = parseFloat(customVal);
    if (Number.isNaN(amount) || amount <= 0) {
      setError('Enter a valid amount.');
      return;
    }
    try {
      await onTopUp(amount);
      setError(null);
      setSuccessKey(amount);
      setTimeout(() => setSuccessKey(null), reducedMotion ? 1500 : 1200);
      setCustomOpen(false);
      setCustomVal('');
    } catch {
      setError('Insufficient balance for top-up.');
      if (!reducedMotion) {
        setShake(true);
        setTimeout(() => setShake(false), 200);
      }
    }
  };

  const pillStyle = (isPrimary: boolean): React.CSSProperties => ({
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 600,
    border: `1px solid ${isPrimary ? COLOR.accent : 'rgba(0,0,0,0.18)'}`,
    borderRadius: 999,
    background: isPrimary ? COLOR.accent : '#f5f5f5',
    color: isPrimary ? '#fff' : '#333',
    cursor: 'pointer',
    transition: 'background 150ms ease',
  });

  const buttonBase: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {PRESETS.map((amount) => (
        <button
          key={amount}
          aria-label={`Top up ${amount} USDC`}
          onClick={() => handlePreset(amount)}
          style={{
            ...pillStyle(emphasized),
            ...buttonBase,
            animation: shake && !reducedMotion ? 'ls-shake 200ms ease' : undefined,
          }}
        >
          {successKey === amount ? '✓' : `+${amount} USDC`}
        </button>
      ))}

      {/* Custom */}
      <div ref={popoverRef} style={{ position: 'relative', display: 'inline-block' }}>
        <button
          aria-label="Custom top-up amount"
          aria-expanded={customOpen}
          onClick={() => setCustomOpen((v) => !v)}
          style={{ ...pillStyle(false), ...buttonBase }}
        >
          Custom ▾
        </button>
        {customOpen && (
          <div
            role="dialog"
            aria-label="Custom top-up"
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: 4,
              background: '#fff',
              border: `1px solid ${COLOR.border}`,
              borderRadius: 6,
              padding: 10,
              boxShadow: '0 4px 16px rgba(0,0,0,0.16)',
              zIndex: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              minWidth: 160,
            }}
          >
            <label style={{ fontSize: 12, color: COLOR.axis }}>Amount</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="number"
                inputMode="decimal"
                autoFocus
                value={customVal}
                onChange={(e) => setCustomVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCustomConfirm();
                }}
                placeholder="0.00"
                style={{
                  fontFamily: MONO_STACK,
                  fontVariantNumeric: 'tabular-nums',
                  textAlign: 'right',
                  minWidth: '7ch',
                  padding: '4px 8px',
                  border: `1px solid ${COLOR.border}`,
                  borderRadius: 4,
                  fontSize: 13,
                }}
              />
              <span style={{ fontSize: 12, color: COLOR.axis }}>USDC</span>
            </div>
            <button
              onClick={handleCustomConfirm}
              style={{
                padding: '4px 12px',
                fontSize: 12,
                fontWeight: 600,
                border: `1px solid ${COLOR.accent}`,
                borderRadius: 4,
                background: COLOR.accent,
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              Confirm Top-Up
            </button>
          </div>
        )}
      </div>

      {error && (
        <span
          role="alert"
          style={{ fontSize: 12, color: COLOR.red, marginLeft: 4 }}
        >
          {error}
        </span>
      )}

      {!reducedMotion && shake && (
        <style>{`
          @keyframes ls-shake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-4px); }
            75% { transform: translateX(4px); }
          }
        `}</style>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flow animation divider
// ---------------------------------------------------------------------------

function FlowDivider({ status, reducedMotion }: { status: ChannelStatus; reducedMotion: boolean }) {
  if (reducedMotion || status !== 'live') {
    // Static gradient underline
    return (
      <div
        aria-hidden="true"
        style={{
          height: 2,
          background: `linear-gradient(90deg, transparent, ${COLOR.accent}, transparent)`,
          opacity: 0.4,
        }}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'relative',
        height: 2,
        background: COLOR.divider,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: '-40%',
          width: '40%',
          height: '100%',
          background: `linear-gradient(90deg, transparent, ${COLOR.accent}, transparent)`,
          animation: 'ls-flow 2.4s linear infinite',
        }}
      />
      <style>{`
        @keyframes ls-flow {
          from { left: -40%; }
          to { left: 100%; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Close comparison sheet
// ---------------------------------------------------------------------------

interface CloseComparisonProps {
  onMutualClose?: () => void;
  onUnilateralClose?: () => void;
  counterpartyResponsive: boolean;
}

function CloseComparison({
  onMutualClose,
  onUnilateralClose,
  counterpartyResponsive,
}: CloseComparisonProps) {
  const rows = [
    { mutual: '✓ Instant settlement', unilateral: '⏳ Challenge window delay' },
    { mutual: '✓ Both parties sign', unilateral: '◐ One party initiates' },
    { mutual: '✓ No on-chain dispute', unilateral: '▲ Dispute may be raised' },
    { mutual: '✓ Lowest gas', unilateral: '⚠ Higher gas + timeout' },
  ];

  return (
    <div style={{ marginTop: 18 }}>
      <table
        style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}
      >
        <caption style={{ textAlign: 'left', fontWeight: 600, marginBottom: 8, fontSize: 14 }}>
          Close Path Comparison
        </caption>
        <thead>
          <tr>
            <th scope="col" style={{ ...closeThStyle, color: COLOR.accent }}>
              Mutual Close
            </th>
            <th scope="col" style={{ ...closeThStyle, color: COLOR.red }}>
              Unilateral Dispute Close
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
              <td style={{ ...closeTdStyle, color: '#1C2333' }}>{r.mutual}</td>
              <td style={{ ...closeTdStyle, color: '#1C2333' }}>{r.unilateral}</td>
            </tr>
          ))}
          <tr>
            <td style={{ ...closeTdStyle, fontSize: 12, color: COLOR.axis }}>
              Result: funds settle in the next block.
            </td>
            <td style={{ ...closeTdStyle, fontSize: 12, color: COLOR.axis }}>
              Result: funds held in escrow until the challenge window (default 48h) ends.
            </td>
          </tr>
          <tr>
            <td style={{ ...closeTdStyle, fontSize: 12, color: COLOR.axis }}>
              Recommended when both parties are cooperative.
            </td>
            <td style={{ ...closeTdStyle, fontSize: 12, color: COLOR.axis }}>
              Use when the counterparty is unresponsive or hostile.
            </td>
          </tr>
        </tbody>
      </table>

      <p style={{ fontSize: 12, color: COLOR.axis, margin: '8px 0 12px' }}>
        Mutual signatures settle instantly. Unilateral close enters a challenge window so the
        other party can dispute the final balance.
      </p>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          onClick={onMutualClose}
          disabled={!counterpartyResponsive}
          title={
            counterpartyResponsive
              ? 'Initiate mutual close with counterparty signature'
              : 'Counterparty signature pending'
          }
          style={{
            padding: '8px 16px',
            fontSize: 13,
            fontWeight: 600,
            border: `1px solid ${COLOR.accent}`,
            borderRadius: 6,
            background: counterpartyResponsive ? COLOR.accent : '#E5E9F0',
            color: counterpartyResponsive ? '#fff' : COLOR.empty,
            cursor: counterpartyResponsive ? 'pointer' : 'not-allowed',
          }}
        >
          Initiate Mutual Close
        </button>
        <button
          onClick={onUnilateralClose}
          style={{
            padding: '8px 16px',
            fontSize: 13,
            fontWeight: 600,
            border: `1px solid ${COLOR.red}`,
            borderRadius: 6,
            background: 'transparent',
            color: COLOR.red,
            cursor: 'pointer',
          }}
        >
          Initiate Unilateral →
        </button>
      </div>
    </div>
  );
}

const closeThStyle: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  borderBottom: '2px solid rgba(0,0,0,0.12)',
  fontSize: 13,
  fontWeight: 700,
  width: '50%',
};

const closeTdStyle: React.CSSProperties = {
  padding: '6px 12px',
  verticalAlign: 'top',
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function LiveStreamCounter({
  channelId,
  channelLabel,
  flowRateUsdcPerMin,
  kwhPerUsdc = 4.96, // example: ~5 kWh per USDC at standard tariff
  totalDeposit,
  claimed,
  accrued: accruedProp,
  lastLedgerTimestamp,
  ratePerSecond,
  depositCap,
  onReconcile,
  status = 'live',
  onTopUp,
  onMutualClose,
  onUnilateralClose,
  counterpartyResponsive = true,
  forceReducedMotion,
}: LiveStreamCounterProps) {
  // Reduced motion detection
  const [mqReduced, setMqReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setMqReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setMqReduced(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  const reducedMotion = forceReducedMotion ?? mqReduced;

  // Resolve interpolation inputs.
  const mountTsRef = useRef<number>(Date.now());
  const anchorTs = lastLedgerTimestamp ?? mountTsRef.current;
  const effectiveRatePerSecond =
    ratePerSecond !== undefined ? ratePerSecond : flowRateUsdcPerMin / 60;
  const effectiveDepositCap =
    depositCap !== undefined ? depositCap : totalDeposit;

  // Live accrued value (BigInt fixed-point interpolation, clamped to deposit cap)
  const liveAccrued = useLiveAccrual(
    accruedProp,
    effectiveRatePerSecond,
    status,
    reducedMotion,
    effectiveDepositCap,
    anchorTs,
    onReconcile,
  );

  // Clamp accrued so it never exceeds remaining buffer (min(accrued, deposit))
  const cappedAccrued = Math.min(liveAccrued, Math.max(0, totalDeposit - claimed));
  const remaining = Math.max(0, totalDeposit - claimed - cappedAccrued);

  // Runway
  const runwayHours = useMemo(
    () => computeRunwayHours(remaining, flowRateUsdcPerMin),
    [remaining, flowRateUsdcPerMin],
  );
  const runway = runwayState(runwayHours, status);

  const isDepleted = status === 'depleted' || (totalDeposit > 0 && claimed + cappedAccrued >= totalDeposit);
  const effectiveStatus: ChannelStatus = isDepleted ? 'depleted' : status;
  const showTopUp = effectiveStatus !== 'closed';

  return (
    <div
      style={{
        background: COLOR.cardBg,
        border: `1px solid ${COLOR.border}`,
        borderRadius: 10,
        overflow: 'hidden',
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 640,
      }}
    >
      {/* Header */}
      <div style={{ padding: '12px 16px 0' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 10,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            <span aria-hidden="true" style={{ color: COLOR.accent, marginRight: 6 }}>
              ◌
            </span>
            Channel #{channelId} · {channelLabel}
          </h2>
          <button
            aria-label="Channel actions menu"
            style={{
              background: 'none',
              border: 'none',
              fontSize: 16,
              cursor: 'pointer',
              color: COLOR.axis,
              padding: '2px 6px',
            }}
          >
            ⋯
          </button>
        </div>

        {/* Flow animation divider */}
        <FlowDivider status={effectiveStatus} reducedMotion={reducedMotion} />

        {/* Flow-rate badge */}
        <div style={{ padding: '12px 0' }}>
          <FlowRateBadge
            flowRateUsdcPerMin={flowRateUsdcPerMin}
            kwhPerUsdc={kwhPerUsdc}
            status={effectiveStatus}
            reducedMotion={reducedMotion}
          />
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '0 16px 16px' }}>
        {/* Progress bar */}
        <ProgressBar
          totalDeposit={totalDeposit}
          claimed={claimed}
          accrued={cappedAccrued}
          reducedMotion={reducedMotion}
        />

        {/* Depleted banner */}
        {isDepleted && (
          <div
            role="alert"
            style={{
              marginTop: 12,
              padding: '6px 12px',
              background: 'rgba(213, 94, 0, 0.12)',
              border: `1px solid ${COLOR.red}`,
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 600,
              color: COLOR.red,
            }}
          >
            ⚠ Depleted — accrued value reached 100% of deposited funds. Top up to resume.
          </div>
        )}

        {/* Runway */}
        <RunwayIndicator
          runwayHours={runwayHours}
          state={runway.state}
          label={runway.label}
          color={runway.color}
          textColor={runway.textColor}
          reducedMotion={reducedMotion}
        />

        {/* Top-up pills */}
        {showTopUp && onTopUp && (
          <div style={{ marginTop: 10 }}>
            <TopUpPill
              onTopUp={onTopUp}
              reducedMotion={reducedMotion}
              emphasized={isDepleted || runway.state === 'red'}
            />
          </div>
        )}

        {/* Close comparison sheet */}
        <CloseComparison
          onMutualClose={onMutualClose}
          onUnilateralClose={onUnilateralClose}
          counterpartyResponsive={counterpartyResponsive}
        />
      </div>
    </div>
  );
}

export default LiveStreamCounter;

// ---------------------------------------------------------------------------
// Test-only exports (used by LiveStreamCounter.test.tsx)
// ---------------------------------------------------------------------------

export const __test__ = {
  interpolateAccruedFixedPoint,
  clampToDeposit,
  toFixedPoint,
  fromFixedPoint,
  RECONCILE_INTERVAL_MS,
  FIXED_POINT_SCALE_NUM,
};
