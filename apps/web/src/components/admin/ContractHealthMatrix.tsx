/**
 * ContractHealthMatrix.tsx
 *
 * System Health Heartbeat for the Cypher GridPay Admin Orchestrator.
 * Implements the UX spec in docs/ux/admin-orchestrator-safety-ux.md
 *
 * Exports:
 *   ContractHealthMatrix   — Four traffic-light contract status tiles with
 *                            drill-down panel (schema version, TTL, multisig
 *                            approvals, recent events).
 *   AdminHeader            — Persistent admin header with Environment Banner,
 *                            Health Matrix, and always-visible Emergency Pause
 *                            button.
 *
 * Design invariants:
 *   - Tiles are always visible in the admin header — no navigation needed.
 *   - Drill-down shows schema version, TTL, pending multisig actions, events.
 *   - Auditor role disables approve/action buttons with explicit lock tooltip.
 *   - Emergency Pause button in header is always reachable for P0 response.
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { Network, ViewerRole } from "./EmergencyPauseModal";
import { EnvironmentBanner } from "./EmergencyPauseModal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContractName = "Payment" | "Escrow" | "Refund" | "Admin";
export type HealthStatus = "healthy" | "warning" | "critical" | "unknown";

export interface MultisigAction {
  actionId: string;
  description: string;
  approvalsReceived: number;
  approvalsRequired: number;
  /** Called when the signer clicks "Approve". */
  onApprove?: () => void;
}

export interface ContractEvent {
  timestamp: string; // ISO string or human-readable
  eventType: string;
  detail: string;
  txHash?: string;
}

export interface DeprecatedContract {
  contractId: string;
  /** Human-readable label / alias of the deprecated contract. */
  alias?: string;
  /** Ledger at which the contract was deprecated. */
  deprecatedAtLedger?: number;
  /** Optional reason / migration note. */
  reason?: string;
}

export interface ContractHealth {
  name: ContractName;
  status: HealthStatus;
  /** On-chain contract ID (C...). */
  contractId?: string;
  schemaVersion: string;
  schemaExpected: string;
  /** Whether the contract is currently paused (emergency circuit breaker). */
  paused?: boolean;
  ttlLedgersRemaining?: number;
  storageEntries?: number;
  pendingMultisig?: MultisigAction[];
  recentEvents?: ContractEvent[];
  lastCheckedAgo?: string; // e.g. "4s ago"
  /** Deprecated contract history from get_deprecated_contracts. */
  deprecatedContracts?: DeprecatedContract[];
}

export interface ContractHealthMatrixProps {
  contracts: ContractHealth[];
  viewerRole?: ViewerRole;
  lastSyncAgo?: string; // e.g. "4s ago"
  /** True while an RPC poll is in flight / degraded. */
  syncing?: boolean;
  /** Current backoff delay in ms when RPC is degraded (0 = healthy). */
  backoffMs?: number;
  /** Last RPC error message, if any. */
  rpcError?: string | null;
}

export interface AdminHeaderProps {
  network: Network;
  contracts: ContractHealth[];
  viewerRole?: ViewerRole;
  lastSyncAgo?: string;
  onEmergencyPauseClick: () => void;
  syncing?: boolean;
  backoffMs?: number;
  rpcError?: string | null;
}

// ---------------------------------------------------------------------------
// Dark mode hook (duplicated here so this file is self-contained)
// ---------------------------------------------------------------------------

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  return dark;
}

// ---------------------------------------------------------------------------
// Traffic-light theme tokens
// ---------------------------------------------------------------------------

type StatusTokens = {
  bg: string;
  text: string;
  dot: string;
  border: string;
};

const STATUS_TOKENS: Record<HealthStatus, { light: StatusTokens; dark: StatusTokens }> = {
  healthy: {
    light: { bg: "#DCFCE7", text: "#166534", dot: "#22C55E", border: "#86EFAC" },
    dark:  { bg: "#14532D", text: "#BBF7D0", dot: "#4ADE80", border: "#166534" },
  },
  warning: {
    light: { bg: "#FEFCE8", text: "#713F12", dot: "#EAB308", border: "#FDE047" },
    dark:  { bg: "#422006", text: "#FEF9C3", dot: "#FACC15", border: "#713F12" },
  },
  critical: {
    light: { bg: "#FEF2F2", text: "#7F1D1D", dot: "#EF4444", border: "#FCA5A5" },
    dark:  { bg: "#450A0A", text: "#FEE2E2", dot: "#F87171", border: "#7F1D1D" },
  },
  unknown: {
    light: { bg: "#F9FAFB", text: "#4B5563", dot: "#9CA3AF", border: "#E5E7EB" },
    dark:  { bg: "#1F2937", text: "#D1D5DB", dot: "#6B7280", border: "#374151" },
  },
};

function statusTokens(status: HealthStatus, dark: boolean): StatusTokens {
  return dark ? STATUS_TOKENS[status].dark : STATUS_TOKENS[status].light;
}

function statusLabel(status: HealthStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// ---------------------------------------------------------------------------
// TTL helpers
// ---------------------------------------------------------------------------

const LEDGERS_PER_DAY = 17280; // ~5s per ledger

function ttlApproxDays(ledgers: number): string {
  const days = Math.floor(ledgers / LEDGERS_PER_DAY);
  if (days >= 365) return `~${Math.floor(days / 365)}y`;
  if (days >= 30)  return `~${Math.floor(days / 30)}mo`;
  if (days >= 1)   return `~${days}d`;
  const hours = Math.floor((ledgers / LEDGERS_PER_DAY) * 24);
  return `~${hours}h`;
}

function ttlWarning(ledgers?: number): boolean {
  if (!ledgers) return false;
  // Warning if < 20% of one year remaining
  return ledgers < LEDGERS_PER_DAY * 73;
}

function shortContractId(id?: string): string {
  if (!id) return "—";
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Pulsing status dot
// ---------------------------------------------------------------------------

function StatusDot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        animation: pulse ? "dotPulse 2s ease-in-out infinite" : undefined,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Multisig approval row
// ---------------------------------------------------------------------------

interface MultisigRowProps {
  action: MultisigAction;
  viewerRole: ViewerRole;
  dark: boolean;
}

function MultisigRow({ action, viewerRole, dark }: MultisigRowProps) {
  const [showTip, setShowTip] = useState(false);
  const pct = (action.approvalsReceived / action.approvalsRequired) * 100;
  const filled = dark ? "#3B82F6" : "#2563EB";
  const track = dark ? "#374151" : "#E5E7EB";
  const textPrimary = dark ? "#F9FAFB" : "#111827";
  const textMuted = dark ? "#9CA3AF" : "#6B7280";
  const isAuditor = viewerRole === "auditor";

  return (
    <div
      style={{
        padding: "10px 12px",
        background: dark ? "#111827" : "#F9FAFB",
        border: `1px solid ${dark ? "#374151" : "#E5E7EB"}`,
        borderRadius: 6,
        marginBottom: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: textPrimary }}>{action.description}</div>
          <div style={{ fontSize: 11, color: textMuted, marginTop: 2 }}>
            {action.approvalsReceived} / {action.approvalsRequired} approvals
          </div>
        </div>
        {/* Approve button */}
        <span
          style={{ position: "relative" }}
          onMouseEnter={() => setShowTip(true)}
          onMouseLeave={() => setShowTip(false)}
        >
          <button
            type="button"
            aria-disabled={isAuditor}
            aria-label={`Approve ${action.description}`}
            onClick={isAuditor ? undefined : action.onApprove}
            style={{
              padding: "5px 12px",
              background: isAuditor ? (dark ? "#374151" : "#D1D5DB") : (dark ? "#2563EB" : "#1D4ED8"),
              color: isAuditor ? (dark ? "#6B7280" : "#9CA3AF") : "#FFFFFF",
              border: "none",
              borderRadius: 5,
              fontSize: 12,
              fontWeight: 600,
              cursor: isAuditor ? "not-allowed" : "pointer",
              opacity: isAuditor ? 0.45 : 1,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {isAuditor && <span aria-hidden="true">🔒</span>}
            Approve
          </button>
          {showTip && isAuditor && (
            <span
              role="tooltip"
              style={{
                position: "absolute",
                bottom: "calc(100% + 5px)",
                right: 0,
                background: "#1F2937",
                color: "#F9FAFB",
                fontSize: 11,
                padding: "4px 8px",
                borderRadius: 4,
                whiteSpace: "nowrap",
                zIndex: 100,
                pointerEvents: "none",
              }}
            >
              View-only access
            </span>
          )}
        </span>
      </div>
      {/* Progress bar */}
      <div
        role="progressbar"
        aria-valuenow={action.approvalsReceived}
        aria-valuemin={0}
        aria-valuemax={action.approvalsRequired}
        aria-label={`${action.approvalsReceived} of ${action.approvalsRequired} approvals`}
        style={{ height: 6, background: track, borderRadius: 3, overflow: "hidden" }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: filled, borderRadius: 3, transition: "width 0.3s" }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drill-down panel
// ---------------------------------------------------------------------------

interface DrillDownPanelProps {
  contract: ContractHealth;
  viewerRole: ViewerRole;
  dark: boolean;
  onClose: () => void;
  panelId: string;
}

function DrillDownPanel({ contract, viewerRole, dark, onClose, panelId }: DrillDownPanelProps) {
  const tk = statusTokens(contract.status, dark);
  const textPrimary = dark ? "#F9FAFB" : "#111827";
  const textMuted = dark ? "#9CA3AF" : "#6B7280";
  const border = dark ? "#374151" : "#E5E7EB";
  const bg = dark ? "#1F2937" : "#FFFFFF";
  const rowBg = dark ? "#111827" : "#F9FAFB";
  const schemaMismatch = contract.schemaVersion !== contract.schemaExpected;

  return (
    <div
      id={panelId}
      role="region"
      aria-label={`${contract.name} contract details`}
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        left: 0,
        right: 0,
        zIndex: 500,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 8,
        boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
        padding: "16px",
        minWidth: 320,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div>
          <span style={{ fontSize: 15, fontWeight: 700, color: textPrimary }}>{contract.name} Contract</span>
          <span style={{ marginLeft: 8, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <StatusDot color={tk.dot} pulse={contract.status === "critical"} />
            <span style={{ fontSize: 12, color: tk.text, fontWeight: 600 }}>{statusLabel(contract.status)}</span>
          </span>
          {contract.lastCheckedAgo && (
            <span style={{ marginLeft: 8, fontSize: 11, color: textMuted }}>— last checked {contract.lastCheckedAgo}</span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${contract.name} details`}
          style={{ background: "none", border: "none", cursor: "pointer", color: textMuted, fontSize: 18, padding: "0 4px" }}
        >
          ×
        </button>
      </div>

      {/* Metadata table */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 14, fontSize: 13 }}>
        <tbody>
          {[
            {
              label: "Contract ID",
              value: (
                <span title={contract.contractId ?? undefined}>
                  {contract.contractId ? (
                    <span style={{ fontFamily: "monospace" }}>{contract.contractId}</span>
                  ) : (
                    <span style={{ color: textMuted }}>—</span>
                  )}
                </span>
              ),
            },
            {
              label: "Pause state",
              value: contract.paused ? (
                <span style={{ color: dark ? "#FCA5A5" : "#DC2626", fontWeight: 700 }}>
                  ⏸ PAUSED
                </span>
              ) : (
                <span style={{ color: dark ? "#86EFAC" : "#16A34A" }}>▶ Active</span>
              ),
            },
            {
              label: "Schema version",
              value: (
                <span>
                  <span style={{ fontFamily: "monospace" }}>{contract.schemaVersion}</span>
                  {schemaMismatch ? (
                    <span style={{ marginLeft: 8, color: dark ? "#FEF08A" : "#CA8A04", fontSize: 11, fontWeight: 600 }}>
                      ⚠ Expected {contract.schemaExpected}
                    </span>
                  ) : (
                    <span style={{ marginLeft: 8, color: dark ? "#86EFAC" : "#16A34A", fontSize: 11 }}>✓ Current</span>
                  )}
                </span>
              ),
            },
            contract.ttlLedgersRemaining !== undefined
              ? {
                  label: "TTL remaining",
                  value: (
                    <span style={{ color: ttlWarning(contract.ttlLedgersRemaining) ? (dark ? "#FEF08A" : "#CA8A04") : textPrimary }}>
                      {contract.ttlLedgersRemaining.toLocaleString()} ledgers{" "}
                      ({ttlApproxDays(contract.ttlLedgersRemaining)})
                      {ttlWarning(contract.ttlLedgersRemaining) && " ⚠ Low"}
                    </span>
                  ),
                }
              : null,
            contract.storageEntries !== undefined
              ? { label: "Storage entries", value: <span>{contract.storageEntries.toLocaleString()}</span> }
              : null,
          ]
            .filter(Boolean)
            .map((row, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${border}` }}>
                <td style={{ padding: "7px 0", color: textMuted, width: 160, fontWeight: 500, verticalAlign: "top" }}>{row!.label}</td>
                <td style={{ padding: "7px 0", color: textPrimary, fontFamily: "monospace", verticalAlign: "top" }}>{row!.value}</td>
              </tr>
            ))}
        </tbody>
      </table>

      {/* Multisig approvals */}
      {contract.pendingMultisig && contract.pendingMultisig.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            Pending Multisig Approvals
          </div>
          {contract.pendingMultisig.map((action) => (
            <MultisigRow key={action.actionId} action={action} viewerRole={viewerRole} dark={dark} />
          ))}
        </div>
      )}

      {/* Deprecated contract history */}
      {contract.deprecatedContracts && contract.deprecatedContracts.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            Deprecated Contract History
          </div>
          <div
            style={{
              background: rowBg,
              border: `1px solid ${border}`,
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            {contract.deprecatedContracts.map((dep, i) => (
              <div
                key={`${dep.contractId}-${i}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: 8,
                  padding: "7px 10px",
                  borderBottom:
                    i < contract.deprecatedContracts!.length - 1
                      ? `1px solid ${border}`
                      : undefined,
                  fontSize: 12,
                }}
              >
                <span style={{ color: textPrimary, fontFamily: "monospace" }}>
                  <span title={dep.contractId}>{shortContractId(dep.contractId)}</span>
                  {dep.alias ? <span style={{ color: textMuted, fontFamily: "inherit" }}> — {dep.alias}</span> : null}
                  {dep.reason ? <span style={{ color: textMuted, fontFamily: "inherit" }}> ({dep.reason})</span> : null}
                </span>
                <span style={{ color: textMuted, fontFamily: "monospace", whiteSpace: "nowrap" }}>
                  {dep.deprecatedAtLedger !== undefined ? `ledger ${dep.deprecatedAtLedger.toLocaleString()}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent events */}
      {contract.recentEvents && contract.recentEvents.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            Recent Events
          </div>
          <div
            style={{
              background: rowBg,
              border: `1px solid ${border}`,
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            {contract.recentEvents.slice(0, 10).map((ev, i) => (
              <div
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "80px 1fr auto",
                  gap: 8,
                  padding: "7px 10px",
                  borderBottom: i < contract.recentEvents!.length - 1 ? `1px solid ${border}` : undefined,
                  fontSize: 12,
                }}
              >
                <span style={{ color: textMuted, fontFamily: "monospace", whiteSpace: "nowrap" }}>{ev.timestamp}</span>
                <span style={{ color: textPrimary }}>
                  <strong>{ev.eventType}</strong>
                  {ev.detail ? <span style={{ color: textMuted }}> — {ev.detail}</span> : null}
                </span>
                {ev.txHash && (
                  <span style={{ color: dark ? "#60A5FA" : "#2563EB", fontFamily: "monospace", fontSize: 11 }}>
                    {ev.txHash.slice(0, 4)}…{ev.txHash.slice(-4)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual contract tile
// ---------------------------------------------------------------------------

interface ContractTileProps {
  contract: ContractHealth;
  viewerRole: ViewerRole;
  dark: boolean;
}

function ContractTile({ contract, viewerRole, dark }: ContractTileProps) {
  const [open, setOpen] = useState(false);
  const tileRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const tk = statusTokens(contract.status, dark);

  // Close panel when clicking outside
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (tileRef.current && !tileRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={tileRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${contract.name} contract: ${statusLabel(contract.status)} — click for details`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "7px 12px",
          background: tk.bg,
          border: `1px solid ${tk.border}`,
          borderRadius: 7,
          cursor: "pointer",
          transition: "opacity 0.15s",
        }}
      >
        <StatusDot color={tk.dot} pulse={contract.status === "critical"} />
        <div style={{ textAlign: "left" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: tk.text, whiteSpace: "nowrap" }}>
            {contract.name}
            {contract.paused && (
              <span
                aria-label="paused"
                title="Contract paused"
                style={{ marginLeft: 5, fontSize: 10 }}
              >
                ⏸
              </span>
            )}
          </div>
          <div style={{ fontSize: 10, color: tk.text, opacity: 0.75, fontWeight: 500 }}>
            {statusLabel(contract.status)}
            {contract.contractId ? ` · ${shortContractId(contract.contractId)}` : ""}
          </div>
        </div>
      </button>

      {open && (
        <DrillDownPanel
          contract={contract}
          viewerRole={viewerRole}
          dark={dark}
          onClose={() => setOpen(false)}
          panelId={panelId}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ContractHealthMatrix
// ---------------------------------------------------------------------------

const CONTRACT_ORDER: ContractName[] = ["Payment", "Escrow", "Refund", "Admin"];

export function ContractHealthMatrix({
  contracts,
  viewerRole = "signer",
  lastSyncAgo,
  syncing = false,
  backoffMs = 0,
  rpcError = null,
}: ContractHealthMatrixProps) {
  const dark = usePrefersDark();
  const textMuted = dark ? "#9CA3AF" : "#6B7280";
  const degraded = backoffMs > 0 || !!rpcError;

  // Ensure all four contracts render, even if the poller has not yet
  // returned data for one of them (e.g. first tick / partial RPC failure).
  const byName = new Map<ContractName, ContractHealth>();
  for (const c of contracts) byName.set(c.name, c);
  const ordered: ContractHealth[] = CONTRACT_ORDER.map(
    (name) =>
      byName.get(name) ?? {
        name,
        status: "unknown" as HealthStatus,
        schemaVersion: "—",
        schemaExpected: "—",
      }
  );

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600, color: textMuted, whiteSpace: "nowrap" }}>
        System Health
      </span>
      {ordered.map((c) => (
        <ContractTile key={c.name} contract={c} viewerRole={viewerRole} dark={dark} />
      ))}
      <span
        style={{
          fontSize: 11,
          color: degraded ? (dark ? "#FCA5A5" : "#DC2626") : textMuted,
          marginLeft: "auto",
          whiteSpace: "nowrap",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
        role="status"
        aria-live="polite"
      >
        {syncing && (
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              border: `2px solid ${degraded ? (dark ? "#FCA5A5" : "#DC2626") : textMuted}`,
              borderTopColor: "transparent",
              animation: "dotPulse 1s linear infinite",
            }}
          />
        )}
        {degraded
          ? `RPC degraded${backoffMs > 0 ? ` — retrying in ${Math.round(backoffMs / 1000)}s` : ""}`
          : lastSyncAgo
          ? `Last sync: ${lastSyncAgo}`
          : null}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AdminHeader
// ---------------------------------------------------------------------------

export function AdminHeader({
  network,
  contracts,
  viewerRole = "signer",
  lastSyncAgo,
  onEmergencyPauseClick,
  syncing = false,
  backoffMs = 0,
  rpcError = null,
}: AdminHeaderProps) {
  const dark = usePrefersDark();
  const isAuditor = viewerRole === "auditor";
  const [showAuditorTip, setShowAuditorTip] = useState(false);
  const textPrimary = dark ? "#F9FAFB" : "#111827";
  const textMuted = dark ? "#9CA3AF" : "#6B7280";
  const headerBg = dark ? "#111827" : "#FFFFFF";
  const border = dark ? "#374151" : "#E5E7EB";

  return (
    <header style={{ position: "sticky", top: 0, zIndex: 9000, width: "100%" }}>
      {/* Environment banner sits above header */}
      <EnvironmentBanner network={network} />

      {/* Main header bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "10px 20px",
          background: headerBg,
          borderBottom: `1px solid ${border}`,
          flexWrap: "wrap",
        }}
      >
        {/* Logo / wordmark */}
        <div style={{ fontSize: 14, fontWeight: 700, color: textPrimary, whiteSpace: "nowrap" }}>
          GridPay Admin
        </div>

        {/* Auditor badge */}
        {isAuditor && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              padding: "2px 8px",
              background: dark ? "#1E3A8A" : "#DBEAFE",
              color: dark ? "#93C5FD" : "#1D4ED8",
              border: `1px solid ${dark ? "#3B82F6" : "#93C5FD"}`,
              borderRadius: 4,
              textTransform: "uppercase",
              whiteSpace: "nowrap",
            }}
          >
            AUDITOR VIEW
          </span>
        )}

        {/* Health matrix — takes remaining space */}
        <div style={{ flex: 1 }}>
          <ContractHealthMatrix
            contracts={contracts}
            viewerRole={viewerRole}
            lastSyncAgo={lastSyncAgo}
            syncing={syncing}
            backoffMs={backoffMs}
            rpcError={rpcError}
          />
        </div>

        {/* Emergency Pause button — always visible */}
        <span
          style={{ position: "relative", flexShrink: 0 }}
          onMouseEnter={() => isAuditor && setShowAuditorTip(true)}
          onMouseLeave={() => setShowAuditorTip(false)}
        >
          <button
            type="button"
            aria-label="Open Emergency Pause dialog"
            aria-disabled={isAuditor}
            onClick={isAuditor ? undefined : onEmergencyPauseClick}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "8px 16px",
              background: isAuditor
                ? (dark ? "#374151" : "#D1D5DB")
                : (dark ? "#7F1D1D" : "#FEF2F2"),
              border: `1px solid ${isAuditor ? (dark ? "#4B5563" : "#9CA3AF") : (dark ? "#F87171" : "#EF4444")}`,
              borderRadius: 6,
              cursor: isAuditor ? "not-allowed" : "pointer",
              opacity: isAuditor ? 0.5 : 1,
              color: isAuditor ? (dark ? "#6B7280" : "#9CA3AF") : (dark ? "#FCA5A5" : "#DC2626"),
              fontSize: 13,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            <span aria-hidden="true" style={{ fontSize: 15 }}>⬛</span>
            Emergency Pause
          </button>
          {showAuditorTip && (
            <span
              role="tooltip"
              style={{
                position: "absolute",
                top: "calc(100% + 5px)",
                right: 0,
                background: "#1F2937",
                color: "#F9FAFB",
                fontSize: 11,
                padding: "5px 10px",
                borderRadius: 4,
                whiteSpace: "nowrap",
                zIndex: 10001,
                pointerEvents: "none",
                boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
              }}
            >
              You have view-only access on this network
            </span>
          )}
        </span>
      </div>

      <style>{`
        @keyframes dotPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </header>
  );
}

export default ContractHealthMatrix;
