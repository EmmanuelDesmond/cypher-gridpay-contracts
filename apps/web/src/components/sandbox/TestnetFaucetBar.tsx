import React, { useState } from "react";

interface Props { walletAddress?: string; network: "testnet" | "standalone"; }

export default function TestnetFaucetBar({ walletAddress, network }: Props) {
  const [last, setLast] = useState<number>(0);
  const [msg, setMsg] = useState<string>("");
  const cooldownMs = 10000;

  const fund = async () => {
    const now = Date.now();
    if (now - last < cooldownMs) { setMsg("Rate limited. Try again shortly."); return; }
    setLast(now);
    if (!walletAddress) { setMsg("Connect a wallet first."); return; }
    try {
      if (network === "testnet") {
        await fetch(`https://friendbot.stellar.org?addr=${walletAddress}`);
        setMsg("Funded via Friendbot.");
      } else {
        setMsg("Standalone: use local friendbot.");
      }
    } catch {
      setMsg("Faucet request failed.");
    }
  };

  return (
    <div className="flex items-center gap-2 p-2 border rounded">
      <button onClick={fund} className="px-3 py-1 bg-blue-600 text-white rounded">Fund Wallet</button>
      <span className="text-sm">{msg}</span>
    </div>
  );
}
