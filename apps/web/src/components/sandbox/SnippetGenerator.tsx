import React from "react";

export function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function safeStringify(value: unknown, space = 2): string {
  return JSON.stringify(value, bigIntReplacer, space);
}

export interface SnippetInput {
  contract: string;
  method: string;
  args: Record<string, unknown>;
  network: "testnet" | "standalone";
}

export function generateTsSnippet(input: SnippetInput): string {
  const args = safeStringify(input.args, 2);
  return `import { ${input.contract}Client } from "@cypher-gridpay/contracts-sdk";\n\nconst client = new ${input.contract}Client({ network: "${input.network}" });\nconst result = await client.${input.method}(${args});\nconsole.log(result);`;
}

export function generatePySnippet(input: SnippetInput): string {
  const args = JSON.stringify(input.args, bigIntReplacer, 2).replace(/true/g, "True").replace(/false/g, "False").replace(/null/g, "None");
  return `from cypher_gridpay_sdk import ${input.contract}Client\n\nclient = ${input.contract}Client(network="${input.network}")\nresult = client.${input.method}(**${args})\nprint(result)`;
}

export function generateCliSnippet(input: SnippetInput): string {
  const argStr = Object.entries(input.args).map(([k, v]) => `--${k} ${typeof v === "string" ? v : JSON.stringify(v, bigIntReplacer)}`).join(" ");
  return `stellar contract invoke --id <CONTRACT_ID> --source <KEY> --network ${input.network} -- ${input.method} ${argStr}`;
}

export default function SnippetGenerator({ contract, method, args, network }: { contract: string; method: string; args: Record<string, unknown>; network: "testnet" | "standalone" }) {
  const input: SnippetInput = { contract, method, args, network };
  return (
    <div className="space-y-3">
      <div>
        <h4 className="font-semibold">TypeScript</h4>
        <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto"><code>{generateTsSnippet(input)}</code></pre>
      </div>
      <div>
        <h4 className="font-semibold">Python</h4>
        <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto"><code>{generatePySnippet(input)}</code></pre>
      </div>
      <div>
        <h4 className="font-semibold">Stellar CLI</h4>
        <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto"><code>{generateCliSnippet(input)}</code></pre>
      </div>
    </div>
  );
}
