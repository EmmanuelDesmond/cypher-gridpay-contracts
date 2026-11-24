/**
 * ReasonCodeChart
 *
 * Displays refund reason-code velocity over time (daily/weekly epochs).
 * Uses an Okabe-Ito color-blind safe palette with distinct dash patterns so
 * series are distinguishable by shape alone under deuteranopia, protanopia,
 * and tritanopia conditions.
 *
 * Spec: docs/ux/analytics-dataviz-spec.md
 * Issue: #420
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// Palette & series config (mirrors docs/ux/analytics-dataviz-spec.md)
// ---------------------------------------------------------------------------

export type ReasonCodeKey =
  | 'ProductDefect'
  | 'NonDelivery'
  | 'DuplicateCharge'
  | 'Unauthorized'
  | 'CustomerRequest'
  | 'Other';

interface SeriesStyle {
  key: ReasonCodeKey;
  label: string;
  color: string;
  /** SVG strokeDasharray value */
  dash: string;
  /** Accessible description of the line pattern */
  patternLabel: string;
}

export const REASON_CODE_SERIES: SeriesStyle[] = [
  {
    key: 'ProductDefect',
    label: 'Product Defect',
    color: '#0072B2',
    dash: 'none',
    patternLabel: 'solid line',
  },
  {
    key: 'NonDelivery',
    label: 'Non-Delivery',
    color: '#D55E00',
    dash: '6 3',
    patternLabel: 'dashed line',
  },
  {
    key: 'DuplicateCharge',
    label: 'Duplicate Charge',
    color: '#56B4E9',
    dash: '2 3',
    patternLabel: 'dotted line',
  },
  {
    key: 'Unauthorized',
    label: 'Unauthorized',
    color: '#009E73',
    dash: '6 3 2 3',
    patternLabel: 'dash-dot line',
  },
  {
    key: 'CustomerRequest',
    label: 'Customer Request',
    color: '#F0E442',
    dash: '10 4',
    patternLabel: 'long-dashed line',
  },
  {
    key: 'Other',
    label: 'Other',
    color: '#E69F00',
    dash: '2 2 6 2',
    patternLabel: 'dot-dot-dash line',
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EpochDataPoint {
  epochIndex: number;
  /** ISO 8601 date string */
  date: string;
  ProductDefect: number | null;
  NonDelivery: number | null;
  DuplicateCharge: number | null;
  Unauthorized: number | null;
  CustomerRequest: number | null;
  Other: number | null;
  /**
   * Total transactions observed in this epoch. Used to decide whether the
   * epoch has a large enough sample for percentage deltas to be meaningful.
   * When omitted, the epoch is treated as having a sufficient sample.
   */
  transactionCount?: number | null;
}

/**
 * A single row from the on-chain `get_reason_code_velocity_delta` view.
 * `deltaPct` is the epoch-over-epoch percentage change for the reason code.
 */
export interface ReasonCodeVelocityDelta {
  reasonCode: ReasonCodeKey | string;
  /** Percentage change vs. the previous epoch (null when undefined). */
  deltaPct: number | null;
  /** Optional absolute counts for the current / previous epochs. */
  currentCount?: number | null;
  previousCount?: number | null;
  /** Optional per-epoch sample size for the current epoch. */
  transactionCount?: number | null;
}

export interface ReasonCodeChartProps {
  data: EpochDataPoint[];
  granularity?: 'daily' | 'weekly';
  allowLogScale?: boolean;
  defaultVisibleSeries?: ReasonCodeKey[];
  chartId: string;
  /** Called when the user wants to retry a failed data load */
  onRetry?: () => void;
  /** Pass true to show the error/retry state */
  hasError?: boolean;
  /**
   * Velocity deltas sourced from `get_reason_code_velocity_delta`. When
   * provided these are preferred over client-computed deltas in the table.
   */
  velocityDeltas?: ReasonCodeVelocityDelta[];
  /** Minimum transactions per epoch before percentage deltas are shown. */
  minSampleSize?: number;
}

/** Default minimum epoch sample size before percentage deltas are trusted. */
export const DEFAULT_MIN_SAMPLE_SIZE = 5;

type ViewMode = 'chart' | 'table';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function computeDelta(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * An epoch has an insufficient sample when its transaction count is known and
 * below the minimum threshold. Unknown counts are treated as sufficient so we
 * never hide data we cannot reason about.
 */
function isInsufficientSample(
  transactionCount: number | null | undefined,
  minSampleSize: number,
): boolean {
  return (
    typeof transactionCount === 'number' &&
    Number.isFinite(transactionCount) &&
    transactionCount < minSampleSize
  );
}

/**
 * Normalize a raw velocity-delta payload into a lookup keyed by reason code.
 * Unknown reason codes are ignored so the chart only renders known series.
 */
function buildVelocityDeltaMap(
  deltas: ReasonCodeVelocityDelta[] | undefined,
): Map<string, ReasonCodeVelocityDelta> {
  const map = new Map<string, ReasonCodeVelocityDelta>();
  if (!deltas) return map;
  for (const d of deltas) {
    if (d && typeof d.reasonCode === 'string') map.set(d.reasonCode, d);
  }
  return map;
}

function formatDelta(delta: number | null): string {
  if (delta === null) return '—';
  const sign = delta > 0 ? '▲ +' : delta < 0 ? '▼ ' : '— ';
  return `${sign}${Math.abs(delta).toFixed(1)}%`;
}

function deltaColor(delta: number | null): string {
  if (delta === null) return '#8A93A6';
  if (delta > 0) return '#009E73';
  if (delta < 0) return '#D55E00';
  return '#8A93A6';
}

function safeLog(v: number | null): number | null {
  if (v === null || v <= 0) return null;
  return Math.log10(v);
}

function isOutlierPresent(data: EpochDataPoint[]): boolean {
  const allValues: number[] = [];
  REASON_CODE_SERIES.forEach(({ key }) => {
    data.forEach((pt) => {
      const v = pt[key];
      if (v !== null && v > 0) allValues.push(v);
    });
  });
  if (allValues.length < 2) return false;
  const sorted = [...allValues].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return allValues.some((v) => v > median * 10);
}

// ---------------------------------------------------------------------------
// SVG chart internals
// ---------------------------------------------------------------------------

const CHART_PADDING = { top: 24, right: 16, bottom: 40, left: 56 };

interface ChartDimensions {
  width: number;
  height: number;
  innerWidth: number;
  innerHeight: number;
}

function useDimensions(ref: React.RefObject<HTMLDivElement>): ChartDimensions {
  const [dims, setDims] = useState<ChartDimensions>({
    width: 600,
    height: 360,
    innerWidth: 600 - CHART_PADDING.left - CHART_PADDING.right,
    innerHeight: 360 - CHART_PADDING.top - CHART_PADDING.bottom,
  });

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.max(280, entry.contentRect.width);
      const h = w < 480 ? 220 : w < 1024 ? 300 : 360;
      setDims({
        width: w,
        height: h,
        innerWidth: w - CHART_PADDING.left - CHART_PADDING.right,
        innerHeight: h - CHART_PADDING.top - CHART_PADDING.bottom,
      });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);

  return dims;
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

interface TooltipData {
  x: number;
  y: number;
  epochIndex: number;
  date: string;
  values: {
    series: SeriesStyle;
    value: number | null;
    delta: number | null;
  }[];
}

interface TooltipProps {
  data: TooltipData;
  visibleSeries: Set<ReasonCodeKey>;
  containerRect: DOMRect | null;
}

function Tooltip({ data, visibleSeries, containerRect }: TooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({
    position: 'fixed',
    left: data.x + 12,
    top: data.y - 8,
    pointerEvents: 'none',
    zIndex: 50,
  });

  useEffect(() => {
    if (!ref.current) return;
    const tw = ref.current.offsetWidth;
    const th = ref.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = data.x + 12;
    let top = data.y - 8;

    if (vw - data.x < 220) left = data.x - tw - 12;
    if (vh - data.y < 160) top = data.y - th - 8;

    // On narrow screens pin to top of container
    if (vw < 480 && containerRect) {
      left = containerRect.left + 8;
      top = containerRect.top + 8;
    }

    setStyle({ position: 'fixed', left, top, pointerEvents: 'none', zIndex: 50 });
  }, [data.x, data.y, containerRect]);

  const rows = data.values.filter((v) => visibleSeries.has(v.series.key));

  return (
    <div
      ref={ref}
      role="tooltip"
      style={{
        ...style,
        background: '#1C2333',
        color: '#F4F6FA',
        borderRadius: 6,
        padding: '8px 12px',
        fontSize: 13,
        boxShadow: '0 4px 16px rgba(0,0,0,0.32)',
        minWidth: 220,
      }}
    >
      <div style={{ marginBottom: 6, fontWeight: 600, fontSize: 12, color: '#8A93A6' }}>
        {formatDate(data.date)}&nbsp;•&nbsp;Epoch {data.epochIndex}
      </div>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {rows.map(({ series, value, delta }) => (
            <tr key={series.key}>
              <td style={{ paddingRight: 8, paddingBottom: 2 }}>
                <svg width={20} height={10} aria-hidden="true">
                  <line
                    x1={0}
                    y1={5}
                    x2={20}
                    y2={5}
                    stroke={series.color}
                    strokeWidth={2}
                    strokeDasharray={series.dash === 'none' ? undefined : series.dash}
                  />
                </svg>
              </td>
              <td style={{ paddingRight: 12, paddingBottom: 2 }}>{series.label}</td>
              <td
                style={{
                  fontVariantNumeric: 'tabular-nums',
                  textAlign: 'right',
                  paddingRight: 8,
                  paddingBottom: 2,
                }}
              >
                {value === null ? '—' : value.toLocaleString()}
              </td>
              <td
                style={{
                  fontVariantNumeric: 'tabular-nums',
                  textAlign: 'right',
                  color: deltaColor(delta),
                  paddingBottom: 2,
                  whiteSpace: 'nowrap',
                }}
              >
                {formatDelta(delta)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SVG Line Chart
// ---------------------------------------------------------------------------

interface LineChartProps {
  data: EpochDataPoint[];
  dims: ChartDimensions;
  visibleSeries: Set<ReasonCodeKey>;
  logScale: boolean;
  onHover: (tooltip: TooltipData | null) => void;
  containerRef: React.RefObject<HTMLDivElement>;
}

function LineChart({
  data,
  dims,
  visibleSeries,
  logScale,
  onHover,
  containerRef,
}: LineChartProps) {
  const { innerWidth, innerHeight } = dims;
  const n = data.length;

  // Compute value range
  const allValues: number[] = [];
  REASON_CODE_SERIES.forEach(({ key }) => {
    if (!visibleSeries.has(key)) return;
    data.forEach((pt) => {
      const v = pt[key];
      const mapped = logScale ? safeLog(v) : v;
      if (mapped !== null) allValues.push(mapped);
    });
  });

  const minVal = allValues.length ? Math.min(...allValues) : 0;
  const maxVal = allValues.length ? Math.max(...allValues) : 1;
  const range = maxVal - minVal || 1;

  const xScale = (i: number) =>
    n <= 1 ? innerWidth / 2 : (i / (n - 1)) * innerWidth;

  const yScale = (v: number | null): number | null => {
    if (v === null) return null;
    const mapped = logScale ? safeLog(v) : v;
    if (mapped === null) return null;
    return innerHeight - ((mapped - minVal) / range) * innerHeight;
  };

  // Build path segments (gaps for null values)
  function buildPath(key: ReasonCodeKey): string {
    let d = '';
    let penDown = false;
    data.forEach((pt, i) => {
      const y = yScale(pt[key]);
      if (y === null) {
        penDown = false;
        return;
      }
      const x = xScale(i);
      if (!penDown) {
        d += `M ${x} ${y} `;
        penDown = true;
      } else {
        d += `L ${x} ${y} `;
      }
    });
    return d.trim();
  }

  // Tick marks on x-axis
  const xTicks: number[] = [];
  const isMobile = dims.width < 480;
  data.forEach((_, i) => {
    if (isMobile && i % 2 !== 0) return;
    xTicks.push(i);
  });

  // y-axis ticks (5 steps)
  const yTickCount = 5;
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) => {
    const frac = i / yTickCount;
    const rawVal = minVal + frac * range;
    const displayVal = logScale ? Math.pow(10, rawVal) : rawVal;
    const yPos = innerHeight - frac * innerHeight;
    return { yPos, displayVal };
  });

  // Hover detection
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const svgX = e.clientX - rect.left - CHART_PADDING.left;
      const frac = svgX / innerWidth;
      const idx = Math.round(frac * (n - 1));
      if (idx < 0 || idx >= n) {
        onHover(null);
        return;
      }
      const pt = data[idx];
      const values = REASON_CODE_SERIES.map((series) => {
        const prev = idx > 0 ? data[idx - 1][series.key] : null;
        return {
          series,
          value: pt[series.key],
          delta: computeDelta(pt[series.key], prev),
        };
      });
      onHover({
        x: e.clientX,
        y: e.clientY,
        epochIndex: pt.epochIndex,
        date: pt.date,
        values,
      });
    },
    [data, innerWidth, n, onHover, containerRef],
  );

  const handleMouseLeave = useCallback(() => onHover(null), [onHover]);

  return (
    <svg
      width={dims.width}
      height={dims.height}
      role="img"
      aria-label={`Line chart showing refund reason-code velocity across ${n} epoch${n !== 1 ? 's' : ''}.`}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ display: 'block', cursor: 'crosshair' }}
    >
      <g transform={`translate(${CHART_PADDING.left},${CHART_PADDING.top})`}>
        {/* Grid lines */}
        {yTicks.map(({ yPos }) => (
          <line
            key={yPos}
            x1={0}
            y1={yPos}
            x2={innerWidth}
            y2={yPos}
            stroke="rgba(0,0,0,0.08)"
            strokeWidth={1}
          />
        ))}

        {/* Y-axis labels */}
        {yTicks.map(({ yPos, displayVal }) => (
          <text
            key={yPos}
            x={-8}
            y={yPos}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize={11}
            fill="#5A6478"
          >
            {displayVal >= 1000
              ? `${(displayVal / 1000).toFixed(1)}k`
              : displayVal.toFixed(logScale ? 0 : 0)}
          </text>
        ))}

        {/* X-axis ticks & labels */}
        {xTicks.map((i) => (
          <g key={i} transform={`translate(${xScale(i)},${innerHeight})`}>
            <line x1={0} y1={0} x2={0} y2={4} stroke="#5A6478" strokeWidth={1} />
            <text
              y={16}
              textAnchor="middle"
              fontSize={11}
              fill="#5A6478"
            >
              {formatDate(data[i].date).slice(5)} {/* MM-DD */}
            </text>
          </g>
        ))}

        {/* Series lines */}
        {REASON_CODE_SERIES.filter((s) => visibleSeries.has(s.key)).map((series) => {
          const path = buildPath(series.key);
          const pts = data
            .map((pt, i) => ({ y: yScale(pt[series.key]), x: xScale(i) }))
            .filter((p) => p.y !== null);

          return (
            <g key={series.key}>
              {path && (
                <path
                  d={path}
                  fill="none"
                  stroke={series.color}
                  strokeWidth={2}
                  strokeDasharray={series.dash === 'none' ? undefined : series.dash}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              {/* Single-epoch: render a dot */}
              {n === 1 &&
                pts.map((p) => (
                  <circle
                    key={`${series.key}-dot`}
                    cx={p.x}
                    cy={p.y as number}
                    r={4}
                    fill={series.color}
                  />
                ))}
            </g>
          );
        })}

        {/* Axes */}
        <line x1={0} y1={0} x2={0} y2={innerHeight} stroke="#5A6478" strokeWidth={1} />
        <line
          x1={0}
          y1={innerHeight}
          x2={innerWidth}
          y2={innerHeight}
          stroke="#5A6478"
          strokeWidth={1}
        />
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Table fallback view
// ---------------------------------------------------------------------------

interface TableViewProps {
  data: EpochDataPoint[];
  visibleSeries: Set<ReasonCodeKey>;
  chartId: string;
  velocityDeltaMap: Map<string, ReasonCodeVelocityDelta>;
  minSampleSize: number;
}

function TableView({
  data,
  visibleSeries,
  chartId,
  velocityDeltaMap,
  minSampleSize,
}: TableViewProps) {
  const captionId = `${chartId}-table-caption`;
  const activeSeries = useMemo(
    () => REASON_CODE_SERIES.filter((s) => visibleSeries.has(s.key)),
    [visibleSeries],
  );

  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        aria-labelledby={captionId}
        aria-label="Refund reason-code velocity data table"
        style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}
      >
        <caption
          id={captionId}
          style={{ textAlign: 'left', fontWeight: 600, marginBottom: 8, fontSize: 14 }}
        >
          Refund Reason-Code Velocity — Tabular View
        </caption>
        <thead>
          <tr>
            <th scope="col" style={thStyle}>Date</th>
            <th scope="col" style={thStyle}>Epoch</th>
            <th scope="col" style={thStyle}>Txns</th>
            {activeSeries.map((s) => (
              <th scope="col" key={s.key} style={thStyle}>
                {s.label}
              </th>
            ))}
            {activeSeries.map((s) => (
              <th scope="col" key={`${s.key}-delta`} style={thStyle}>
                {s.label} Δ
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((pt, i) => {
            const prev = i > 0 ? data[i - 1] : null;
            const insufficient = isInsufficientSample(
              pt.transactionCount,
              minSampleSize,
            );
            return (
              <tr
                key={pt.epochIndex}
                style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}
              >
                <td style={tdStyle}>{formatDate(pt.date)}</td>
                <td style={tdStyle}>{pt.epochIndex}</td>
                <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>
                  {typeof pt.transactionCount === 'number'
                    ? pt.transactionCount.toLocaleString()
                    : '—'}
                </td>
                {activeSeries.map((s) => (
                  <td key={s.key} style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>
                    {pt[s.key] === null ? '—' : (pt[s.key] as number).toLocaleString()}
                  </td>
                ))}
                {activeSeries.map((s) => {
                  const onChain = velocityDeltaMap.get(s.key);
                  const delta = insufficient
                    ? null
                    : onChain && onChain.deltaPct !== undefined
                      ? onChain.deltaPct
                      : computeDelta(pt[s.key], prev ? prev[s.key] : null);
                  return (
                    <td
                      key={`${s.key}-delta`}
                      style={{
                        ...tdStyle,
                        fontVariantNumeric: 'tabular-nums',
                        color: deltaColor(delta),
                      }}
                    >
                      {insufficient ? (
                        <span title="Insufficient sample size">
                          Insufficient sample
                        </span>
                      ) : (
                        formatDelta(delta)
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ReasonCodeChart({
  data,
  allowLogScale = false,
  defaultVisibleSeries,
  chartId,
  onRetry,
  hasError = false,
  velocityDeltas,
  minSampleSize = DEFAULT_MIN_SAMPLE_SIZE,
}: ReasonCodeChartProps) {
  const uid = useId();
  const toggleGroupId = `${chartId}-toggle-${uid}`;

  // Memoized transforms for large multi-epoch datasets.
  const velocityDeltaMap = useMemo(
    () => buildVelocityDeltaMap(velocityDeltas),
    [velocityDeltas],
  );

  const insufficientEpochCount = useMemo(
    () =>
      data.reduce(
        (acc, pt) =>
          acc + (isInsufficientSample(pt.transactionCount, minSampleSize) ? 1 : 0),
        0,
      ),
    [data, minSampleSize],
  );

  // View mode (chart / table) persisted to localStorage
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

  // Visible series
  const [visibleSeries, setVisibleSeries] = useState<Set<ReasonCodeKey>>(
    () => new Set(defaultVisibleSeries ?? REASON_CODE_SERIES.map((s) => s.key)),
  );

  const toggleSeries = (key: ReasonCodeKey) => {
    setVisibleSeries((prev) => {
      if (prev.has(key) && prev.size === 1) return prev; // keep at least one
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Log scale
  const [logScale, setLogScale] = useState(false);

  // Tooltip
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dims = useDimensions(containerRef);

  const outlierWarning = useMemo(() => isOutlierPresent(data), [data]);
  const isEmpty = data.length === 0;
  const allZero = useMemo(
    () =>
      !isEmpty &&
      REASON_CODE_SERIES.every((s) => data.every((pt) => !pt[s.key])),
    [data, isEmpty],
  );

  // Keyboard handler for toggle group
  const handleToggleKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    current: ViewMode,
  ) => {
    if (e.key === 'ArrowLeft') handleViewMode('chart');
    if (e.key === 'ArrowRight') handleViewMode('table');
  };

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
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          Refund Reason-Code Velocity
        </h2>

        {/* Chart / Table toggle */}
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
              onKeyDown={(e) => handleToggleKeyDown(e, mode)}
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
      <div style={{ padding: '12px 0 0' }}>
        {/* Error state */}
        {hasError && (
          <div
            role="alert"
            style={{ padding: '32px 16px', textAlign: 'center', color: '#D55E00' }}
          >
            <p style={{ margin: '0 0 12px' }}>
              Could not load velocity data.
            </p>
            {onRetry && (
              <button onClick={onRetry} style={retryBtnStyle}>
                Retry ↺
              </button>
            )}
          </div>
        )}

        {/* Empty / zero state */}
        {!hasError && (isEmpty || allZero) && (
          <div
            style={{ padding: '48px 16px', textAlign: 'center', color: '#8A93A6' }}
            aria-live="polite"
          >
            No refund data for this period.
          </div>
        )}

        {/* Insufficient sample size annotation */}
        {!hasError && !isEmpty && !allZero && insufficientEpochCount > 0 && (
          <div
            role="status"
            aria-live="polite"
            style={{
              margin: '0 16px 8px',
              padding: '6px 10px',
              background: 'rgba(0,114,178,0.10)',
              borderRadius: 4,
              fontSize: 12,
              color: '#004a75',
            }}
          >
            Insufficient Sample Size — {insufficientEpochCount} epoch
            {insufficientEpochCount !== 1 ? 's have' : ' has'} fewer than{' '}
            {minSampleSize} transactions. Percentage velocity deltas are hidden
            for those epochs to avoid misleading trends.
          </div>
        )}

        {/* Outlier warning */}
        {!hasError && !isEmpty && !allZero && outlierWarning && !logScale && (
          <div
            role="status"
            style={{
              margin: '0 16px 8px',
              padding: '6px 10px',
              background: 'rgba(230,159,0,0.12)',
              borderRadius: 4,
              fontSize: 12,
              color: '#7a5500',
            }}
          >
            Outlier detected — consider enabling log scale for better readability.
          </div>
        )}

        {/* Chart or table */}
        {!hasError && !isEmpty && !allZero && (
          <div ref={containerRef} style={{ position: 'relative' }}>
            {viewMode === 'chart' ? (
              <LineChart
                data={data}
                dims={dims}
                visibleSeries={visibleSeries}
                logScale={logScale}
                onHover={setTooltip}
                containerRef={containerRef}
              />
            ) : (
              <div style={{ padding: '0 16px 12px' }}>
                <TableView
                  data={data}
                  visibleSeries={visibleSeries}
                  chartId={chartId}
                  velocityDeltaMap={velocityDeltaMap}
                  minSampleSize={minSampleSize}
                />
              </div>
            )}

            {/* Tooltip */}
            {viewMode === 'chart' && tooltip && (
              <Tooltip
                data={tooltip}
                visibleSeries={visibleSeries}
                containerRect={
                  containerRef.current?.getBoundingClientRect() ?? null
                }
              />
            )}
          </div>
        )}

        {/* Legend */}
        {!hasError && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '8px 16px',
              padding: '8px 16px 12px',
            }}
          >
            {REASON_CODE_SERIES.map((series) => {
              const active = visibleSeries.has(series.key);
              return (
                <button
                  key={series.key}
                  onClick={() => toggleSeries(series.key)}
                  aria-pressed={active}
                  title={`Toggle ${series.label} (${series.patternLabel})`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 0',
                    opacity: active ? 1 : 0.35,
                    fontSize: 12,
                    color: '#333',
                  }}
                >
                  <svg width={20} height={10} aria-hidden="true">
                    <line
                      x1={0}
                      y1={5}
                      x2={20}
                      y2={5}
                      stroke={series.color}
                      strokeWidth={2.5}
                      strokeDasharray={series.dash === 'none' ? undefined : series.dash}
                    />
                  </svg>
                  {series.label}
                </button>
              );
            })}

            {/* Log scale toggle */}
            {allowLogScale && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 12,
                  color: '#5A6478',
                  cursor: 'pointer',
                  marginLeft: 'auto',
                }}
              >
                <input
                  type="checkbox"
                  checked={logScale}
                  onChange={(e) => setLogScale(e.target.checked)}
                />
                Log Scale
              </label>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const retryBtnStyle: React.CSSProperties = {
  padding: '6px 16px',
  fontSize: 13,
  border: '1px solid #D55E00',
  borderRadius: 4,
  background: 'transparent',
  color: '#D55E00',
  cursor: 'pointer',
};

export default ReasonCodeChart;
