import React, { useState } from "react";
import SnippetGenerator from "../../components/sandbox/SnippetGenerator";
import TestnetFaucetBar from "../../components/sandbox/TestnetFaucetBar";

const NETWORK = (import.meta as any)?.env?.VITE_STELLAR_NETWORK ?? "testnet";

const CONTRACTS = ["Payment", "Escrow", "Refund", "Admin"];

export default function ContractSandboxPage() {
  const [contract, setContract] = useState("Payment");
  const [method, setMethod] = useState("get_balance");
  const [args, setArgs] = useState<Record<string, unknown>>({ account: "G..." });
  const [result, setResult] = useState<unknown>(null);
  const isMainnet = NETWORK === "mainnet";

  if (isMainnet) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-bold">Contract Sandbox</h1>
        <p className="text-red-600 mt-2">Read-only: sandbox disabled on Stellar Mainnet.</p>
      </div>
    );
  }

  const network = (NETWORK === "standalone" ? "standalone" : "testnet") as "testnet" | "standalone";

  const run = () => {
    setResult({ ok: true, contract, method, args });
  };

  return (
    <div className="p-6 grid grid-cols-3 gap-4">
      <div className="col-span-2 space-y-4">
        <h1 className="text-xl font-bold">Contract Sandbox ({network})</h1>
        <TestnetFaucetBar walletAddress={undefined} network={network} />
        <div className="flex gap-2">
          <select value={contract} onChange={(e) => setContract(e.target.value)}>
            {CONTRACTS.map((c) => <option key={c}>{c}</option>)}
          </select>
          <input value={method} onChange={(e) => setMethod(e.target.value)} className="border px-2" />
        </div>
        <textarea
          value={JSON.stringify(args)}
          onChange={(e) => { try { setArgs(JSON.parse(e.target.value)); } catch {} }}
          className="w-full border p-2 font-mono text-xs"
          rows={6}
        />
        <button onClick={run} className="px-3 py-1 bg-green-600 text-white rounded">Execute (Testnet)</button>
        <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto">{result ? JSON.stringify(result, (k, v) => typeof v === "bigint" ? v.toString() : v, 2) : ""}</pre>
      </div>
      <div>
        <SnippetGenerator contract={contract} method={method} args={args} network={network} />
      </div>
    </div>
  );
}
