/**
 * QuotaGauge
 *
 * Horizontal bar gauge for a single ratio metric (e.g., Chargeback Ratio,
 * Refund Quota Utilization). Shows Warning (75%) and Circuit Breaker Trip
 * (100%) threshold bands with color-blind safe Okabe-Ito palette.
 *
 * Spec: docs/ux/analytics-dataviz-spec.md
 * Issue: #420
 */

import React, {
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuotaGaugeProps {
  /** Gauge label shown as heading */
  label: string;
  /** Current ratio value, 0–1 (or beyond 1 if circuit breaker is tripped) */
  value: number;
  /** Previous epoch value for delta badge */
  previousValue?: number;
  /** Warning threshold, default 0.75 */
  warningThreshold?: number;
  /** Circuit breaker threshold, default 1.0 */
  circuitBreakerThreshold?: number;
  /**
   * MerchantRefundQuota from `get_merchant_refund_summary` — the absolute
   * refund amount (in the settlement token) the merchant is allowed per epoch.
   * When provided alongside `refundAmount`, the gauge renders proximity to the
   * quota in addition to the ratio thresholds.
   */
  merchantRefundQuota?: number;
  /** Refund amount consumed this epoch (same token units as merchantRefundQuota). */
  refundAmount?: number;
  /** Chart card identifier – used for localStorage view mode key */
  chartId: string;
  /** Pass true to show the error/retry state */
  hasError?: boolean;
  /** Called when the user wants to retry a failed data load */
  onRetry?: () => void;
}

type ViewMode = 'chart' | 'table';

// ---------------------------------------------------------------------------
// Palette tokens (Okabe-Ito)
// ---------------------------------------------------------------------------

const COLOR_SAFE = '#0072B2'; // --cb-blue
const COLOR_WARNING = '#F0E442'; // --cb-yellow
const COLOR_CIRCUIT_BREAK = '#D55E00'; // --cb-vermillion

const BAND_WARNING_BG = 'rgba(240, 228, 66, 0.12)';
const BAND_CIRCUIT_BREAK_BG = 'rgba(213, 94, 0, 0.18)';

const COLOR_DELTA_UP = '#009E73'; // --cb-green
const COLOR_DELTA_DOWN = '#D55E00'; // --cb-vermillion
const COLOR_DELTA_FLAT = '#8A93A6';

const COLOR_EMPTY = '#8A93A6';
const COLOR_AXIS = '#5A6478';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function computeDeltaPct(current: number, previous?: number): number | null {
  // Zero-division safe: no previous value or a zero baseline yields no delta.
  if (previous === undefined || previous === null || previous === 0) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * Proximity to a quota expressed as a 0–1 ratio. Zero-division safe: a
 * non-positive or non-finite quota yields null (no proximity to render).
 */
function computeQuotaProximity(amount?: number, quota?: number): number | null {
  if (amount === undefined || quota === undefined) return null;
  if (!Number.isFinite(amount) || !Number.isFinite(quota) || quota <= 0) return null;
  return amount / quota;
}

function formatAmount(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatDeltaBadge(delta: number | null): string {
  if (delta === null) return '—';
  const sign = delta > 0 ? '▲ +' : delta < 0 ? '▼ ' : '— ';
  return `${sign}${Math.abs(delta).toFixed(1)}%`;
}

function deltaColor(delta: number | null): string {
  if (delta === null) return COLOR_DELTA_FLAT;
  if (delta > 0) return COLOR_DELTA_UP;
  if (delta < 0) return COLOR_DELTA_DOWN;
  return COLOR_DELTA_FLAT;
}

function fillRatioFor(value: number, warning: number, circuitBreak: number): string {
  if (value >= circuitBreak) return COLOR_CIRCUIT_BREAK;
  if (value >= warning) return COLOR_WARNING;
  return COLOR_SAFE;
}

/** Clamp value to [0,1] for the rendered bar width. */
function clampWidth(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function QuotaGauge({
  label,
  value,
  previousValue,
  warningThreshold = 0.75,
  circuitBreakerThreshold = 1.0,
  merchantRefundQuota,
  refundAmount,
  chartId,
  hasError = false,
  onRetry,
}: QuotaGaugeProps) {
  const uid = useId();
  const toggleGroupId = `${chartId}-toggle-${uid}`;

  // View mode persisted to localStorage
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return (localStorage.getItem(`analytics.viewMode.${chartId}`) as ViewMode) ?? 'chart';
    } catch {
      return 'chart';
    }
  });

  const handleViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem(`analytics.viewMode.${chartId}`, mode);
    } catch {
      // ignore
    }
  };

  const handleToggleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowLeft') handleViewMode('chart');
    if (e.key === 'ArrowRight') handleViewMode('table');
  };

  // Animated fill
  const [animatedWidth, setAnimatedWidth] = useState(0);
  const requestRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);

  useEffect(() => {
    const target = clampWidth(value);
    const duration = 300;
    const start = animatedWidth;

    startTimeRef.current = null;
    const step = (ts: number) => {
      if (startTimeRef.current === null) startTimeRef.current = ts;
      const elapsed = ts - startTimeRef.current;
      const frac = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - frac, 3); // ease-out cubic
      setAnimatedWidth(start + (target - start) * eased);
      if (frac < 1) {
        requestRef.current = requestAnimationFrame(step);
      } else {
        setAnimatedWidth(target);
        requestRef.current = null;
      }
    };

    requestRef.current = requestAnimationFrame(step);
    return () => {
      if (requestRef.current !== null) cancelAnimationFrame(requestRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const delta = computeDeltaPct(value, previousValue);
  const fillColor = fillRatioFor(value, warningThreshold, circuitBreakerThreshold);
  const circuitBroken = value >= circuitBreakerThreshold;
  const isZero = value <= 0;

  // MerchantRefundQuota proximity (from get_merchant_refund_summary)
  const quotaProximity = computeQuotaProximity(refundAmount, merchantRefundQuota);
  const hasQuota = quotaProximity !== null;
  const quotaTripped = quotaProximity !== null && quotaProximity >= 1;
  const quotaWarning = quotaProximity !== null && quotaProximity >= warningThreshold;
  const quotaColor =
    quotaProximity === null
      ? COLOR_EMPTY
      : fillRatioFor(quotaProximity, warningThreshold, circuitBreakerThreshold);

  // Threshold band positions (as percentages of full width)
  const warningLeftPct = warningThreshold * 100;
  const circuitLeftPct = circuitBreakerThreshold * 100;

  // Tooltip
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const distToWarning = (warningThreshold - value) * 100;
  const distToCircuit = (circuitBreakerThreshold - value) * 100;

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid rgba(0,0,0,0.1)',
        borderRadius: 8,
        overflow: 'hidden',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Card header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid rgba(0,0,0,0.08)',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{label}</h2>

        <div
          role="group"
          id={toggleGroupId}
          aria-label="View as chart or table"
          style={{ display: 'flex', gap: 2 }}
        >
          {(['chart', 'table'] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              aria-pressed={viewMode === mode}
              onClick={() => handleViewMode(mode)}
              onKeyDown={handleToggleKeyDown}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                fontWeight: 500,
                border: '1px solid rgba(0,0,0,0.18)',
                borderRadius: mode === 'chart' ? '4px 0 0 4px' : '0 4px 4px 0',
                background: viewMode === mode ? '#0072B2' : '#f5f5f5',
                color: viewMode === mode ? '#fff' : '#333',
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '16px' }}>
        {hasError && (
          <div
            role="alert"
            style={{ padding: '24px 0', textAlign: 'center', color: COLOR_CIRCUIT_BREAK }}
          >
            <p style={{ margin: '0 0 12px' }}>Could not load {label.toLowerCase()} data.</p>
            {onRetry && (
              <button onClick={onRetry} style={retryBtnStyle}>
                Retry ↺
              </button>
            )}
          </div>
        )}

        {!hasError && isZero && (
          <div
            style={{ padding: '24px 0', textAlign: 'center', color: COLOR_EMPTY }}
            aria-live="polite"
          >
            No data available
          </div>
        )}

        {!hasError && !isZero && viewMode === 'chart' && (
          <>
            {/* Value + delta badge */}
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 12,
                marginBottom: 12,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              <span style={{ fontSize: 28, fontWeight: 700, color: fillColor }}>
                {formatPct(value)}
              </span>
              <span style={{ fontSize: 13, color: deltaColor(delta) }}>
                {formatDeltaBadge(delta)} vs prev epoch
              </span>
            </div>

            {/* Bar */}
            <div
              role="img"
              aria-label={`${label}: ${formatPct(value)} current, warning at ${formatPct(warningThreshold)}, circuit breaker at ${formatPct(circuitBreakerThreshold)}.`}
              onMouseEnter={() => setTooltipVisible(true)}
              onMouseLeave={() => setTooltipVisible(false)}
              onFocus={() => setTooltipVisible(true)}
              onBlur={() => setTooltipVisible(false)}
              tabIndex={0}
              style={{ position: 'relative', width: '100%', maxWidth: 640 }}
            >
              {/* Track */}
              <div
                style={{
                  position: 'relative',
                  height: 24,
                  borderRadius: 4,
                  background: '#EEF0F4',
                  overflow: 'hidden',
                }}
              >
                {/* Warning band */}
                <div
                  style={{
                    position: 'absolute',
                    left: `${warningLeftPct}%`,
                    top: 0,
                    height: '100%',
                    width: `${circuitLeftPct - warningLeftPct}%`,
                    background: BAND_WARNING_BG,
                  }}
                  aria-hidden="true"
                />
                {/* Circuit-break band */}
                <div
                  style={{
                    position: 'absolute',
                    left: `${circuitLeftPct}%`,
                    top: 0,
                    height: '100%',
                    width: `${100 - circuitLeftPct}%`,
                    background: BAND_CIRCUIT_BREAK_BG,
                  }}
                  aria-hidden="true"
                />
                {/* Animated fill */}
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    height: '100%',
                    width: `${animatedWidth * 100}%`,
                    background: fillColor,
                    borderRadius: 4,
                    transition: 'background 200ms ease-out',
                  }}
                />
                {/* Threshold reference lines */}
                <ThresholdLine leftPct={warningLeftPct} color={COLOR_WARNING} />
                <ThresholdLine leftPct={circuitLeftPct} color={COLOR_CIRCUIT_BREAK} />
              </div>

              {/* Tooltip */}
              {tooltipVisible && (
                <div
                  role="tooltip"
                  style={{
                    position: 'absolute',
                    bottom: 32,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: '#1C2333',
                    color: '#F4F6FA',
                    borderRadius: 6,
                    padding: '6px 12px',
                    fontSize: 12,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.32)',
                    zIndex: 10,
                  }}
                >
                  {distToWarning >= 0
                    ? `${distToWarning.toFixed(1)}% below Warning`
                    : `${Math.abs(distToWarning).toFixed(1)}% above Warning`}
                  {'  ·  '}
                  {distToCircuit >= 0
                    ? `${distToCircuit.toFixed(1)}% below Circuit Breaker Trip`
                    : `${Math.abs(distToCircuit).toFixed(1)}% above Circuit Breaker Trip`}
                </div>
              )}

              {/* Axis labels */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginTop: 6,
                  fontSize: 11,
                  color: COLOR_AXIS,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <span>0%</span>
                <span style={{ color: COLOR_WARNING }}>Warning ({formatPct(warningThreshold)})</span>
                <span style={{ color: COLOR_CIRCUIT_BREAK }}>
                  Circuit Breaker Trip ({formatPct(circuitBreakerThreshold)})
                </span>
              </div>
            </div>

            {/* MerchantRefundQuota proximity */}
            {hasQuota && (
              <div
                role="group"
                aria-label={`Merchant refund quota proximity: ${formatPct(quotaProximity as number)} of ${formatAmount(merchantRefundQuota as number)} quota used.`}
                style={{ marginTop: 16 }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    fontSize: 12,
                    color: COLOR_AXIS,
                    marginBottom: 6,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <span style={{ fontWeight: 600 }}>MerchantRefundQuota proximity</span>
                  <span style={{ color: quotaColor, fontWeight: 600 }}>
                    {formatAmount(refundAmount as number)} / {formatAmount(merchantRefundQuota as number)}
                    {'  ·  '}
                    {formatPct(quotaProximity as number)}
                  </span>
                </div>
                <div
                  style={{
                    position: 'relative',
                    height: 12,
                    borderRadius: 4,
                    background: '#EEF0F4',
                    overflow: 'hidden',
                  }}
                  aria-hidden="true"
                >
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      height: '100%',
                      width: `${clampWidth(quotaProximity as number) * 100}%`,
                      background: quotaColor,
                      borderRadius: 4,
                      transition: 'background 200ms ease-out',
                    }}
                  />
                  <ThresholdLine leftPct={warningThreshold * 100} color={COLOR_WARNING} />
                  <ThresholdLine leftPct={circuitBreakerThreshold * 100} color={COLOR_CIRCUIT_BREAK} />
                </div>
              </div>
            )}

            {/* Circuit breaker tripped badge */}
            {circuitBroken && (
              <div
                role="alert"
                style={{
                  marginTop: 12,
                  padding: '6px 12px',
                  background: 'rgba(213, 94, 0, 0.12)',
                  border: `1px solid ${COLOR_CIRCUIT_BREAK}`,
                  borderRadius: 4,
                  fontSize: 13,
                  fontWeight: 600,
                  color: COLOR_CIRCUIT_BREAK,
                  display: 'inline-block',
                }}
              >
                ⚠ Circuit Breaker Tripped
              </div>
            )}

            {/* Quota exceeded badge */}
            {quotaTripped && (
              <div
                role="alert"
                style={{
                  marginTop: 8,
                  padding: '6px 12px',
                  background: 'rgba(213, 94, 0, 0.12)',
                  border: `1px solid ${COLOR_CIRCUIT_BREAK}`,
                  borderRadius: 4,
                  fontSize: 13,
                  fontWeight: 600,
                  color: COLOR_CIRCUIT_BREAK,
                  display: 'inline-block',
                }}
              >
                ⚠ MerchantRefundQuota exceeded
              </div>
            )}
          </>
        )}

        {/* Table view */}
        {!hasError && !isZero && viewMode === 'table' && (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}
              aria-labelledby={`${chartId}-table-caption`}
            >
              <caption
                id={`${chartId}-table-caption`}
                style={{ textAlign: 'left', fontWeight: 600, marginBottom: 8, fontSize: 14 }}
              >
                {label} — Tabular View
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={thStyle}>Metric</th>
                  <th scope="col" style={thStyle}>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                  <th scope="row" style={thStyle}>Current</th>
                  <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>
                    {formatPct(value)}
                  </td>
                </tr>
                <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                  <th scope="row" style={thStyle}>Δ vs prev epoch</th>
                  <td
                    style={{
                      ...tdStyle,
                      fontVariantNumeric: 'tabular-nums',
                      color: deltaColor(delta),
                    }}
                  >
                    {formatDeltaBadge(delta)}
                  </td>
                </tr>
                <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                  <th scope="row" style={thStyle}>Warning threshold</th>
                  <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>
                    {formatPct(warningThreshold)}
                  </td>
                </tr>
                <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                  <th scope="row" style={thStyle}>Circuit Breaker Trip</th>
                  <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>
                    {formatPct(circuitBreakerThreshold)}
                  </td>
                </tr>
                {hasQuota && (
                  <>
                    <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                      <th scope="row" style={thStyle}>MerchantRefundQuota</th>
                      <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>
                        {formatAmount(merchantRefundQuota as number)}
                      </td>
                    </tr>
                    <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                      <th scope="row" style={thStyle}>Refund amount used</th>
                      <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>
                        {formatAmount(refundAmount as number)}
                      </td>
                    </tr>
                    <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                      <th scope="row" style={thStyle}>Quota proximity</th>
                      <td
                        style={{
                          ...tdStyle,
                          fontVariantNumeric: 'tabular-nums',
                          color: quotaColor,
                        }}
                      >
                        {formatPct(quotaProximity as number)}
                      </td>
                    </tr>
                  </>
                )}
                <tr>
                  <th scope="row" style={thStyle}>Status</th>
                  <td style={{ ...tdStyle, color: circuitBroken ? COLOR_CIRCUIT_BREAK : COLOR_AXIS }}>
                    {circuitBroken
                      ? '⚠ Circuit Breaker Tripped'
                      : quotaTripped
                        ? '⚠ MerchantRefundQuota exceeded'
                        : quotaWarning
                          ? 'Warning band'
                          : value >= warningThreshold
                            ? 'Warning band'
                            : 'Safe'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Threshold reference line
// ---------------------------------------------------------------------------

interface ThresholdLineProps {
  leftPct: number;
  color: string;
}

function ThresholdLine({ leftPct, color }: ThresholdLineProps) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: `${leftPct}%`,
        top: 0,
        bottom: 0,
        width: 0,
        borderLeft: `2px dashed ${color}`,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const thStyle: React.CSSProperties = {
  padding: '6px 10px',
  textAlign: 'left',
  borderBottom: '2px solid rgba(0,0,0,0.12)',
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: '5px 10px',
  fontSize: 13,
};

const retryBtnStyle: React.CSSProperties = {
  padding: '6px 16px',
  fontSize: 13,
  border: `1px solid ${COLOR_CIRCUIT_BREAK}`,
  borderRadius: 4,
  background: 'transparent',
  color: COLOR_CIRCUIT_BREAK,
  cursor: 'pointer',
};

export default QuotaGauge;
