import { useState } from "react";
import {
  useGetArtifactMint,
  useRecordArtifactMint,
  getGetArtifactMintQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  artifactId: number;
}

const HEX_ADDR = /^0x[a-fA-F0-9]{40}$/u;
const HEX_TX = /^0x[a-fA-F0-9]{64}$/u;

export function NftMintPanel({ artifactId }: Props) {
  const queryClient = useQueryClient();
  const queryKey = getGetArtifactMintQueryKey(artifactId);
  const { data, isLoading } = useGetArtifactMint(artifactId, {
    query: { queryKey },
  });
  const record = useRecordArtifactMint({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    },
  });

  const [chainId, setChainId] = useState("8453");
  const [contractAddress, setContractAddress] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [txHash, setTxHash] = useState("");
  const [mintedToAddress, setMintedToAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">NFT Mint</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Loading…</CardContent>
      </Card>
    );
  }

  const minted = data.mint;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cid = Number(chainId);
    if (!Number.isFinite(cid) || cid <= 0) {
      setError("Chain ID must be a positive number (1=Ethereum, 8453=Base, 10=Optimism, 42161=Arbitrum).");
      return;
    }
    if (!HEX_ADDR.test(contractAddress)) {
      setError("Contract address must be 0x + 40 hex chars.");
      return;
    }
    if (!tokenId.trim()) {
      setError("Token ID is required.");
      return;
    }
    if (!HEX_TX.test(txHash)) {
      setError("Tx hash must be 0x + 64 hex chars.");
      return;
    }
    if (!HEX_ADDR.test(mintedToAddress)) {
      setError("Recipient address must be 0x + 40 hex chars.");
      return;
    }
    try {
      await record.mutateAsync({
        id: artifactId,
        data: {
          chainId: cid,
          contractAddress,
          tokenId: tokenId.trim(),
          txHash,
          mintedToAddress,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">NFT Mint (1-of-1)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Token Metadata URI</p>
          <code className="block break-all bg-secondary px-2 py-1 text-xs font-mono">
            {data.metadataUri}
          </code>
          <p className="text-xs text-muted-foreground">
            Pass this URL as the <code className="font-mono">uri</code> argument to{" "}
            <code className="font-mono">mintArtifact(...)</code> on your deployed{" "}
            <code className="font-mono">KannakaArtifact</code> contract (see <code className="font-mono">contracts/README.md</code>).
          </p>
        </div>

        {minted ? (
          <div className="border border-accent/40 bg-accent/5 p-3 space-y-1.5 text-xs font-mono">
            <p className="text-accent uppercase tracking-widest text-[10px]">Minted</p>
            <Row label="Chain" value={String(minted.chainId)} />
            <Row label="Contract" value={minted.contractAddress} />
            <Row label="Token ID" value={minted.tokenId} />
            <Row label="Tx Hash" value={minted.txHash} />
            <Row label="Owner" value={minted.mintedToAddress} />
            <Row label="At" value={new Date(minted.mintedAt).toLocaleString()} />
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-3" data-testid="form-record-mint">
            <p className="text-xs text-muted-foreground">
              After deploying the contract and calling{" "}
              <code className="font-mono">mintArtifact(...)</code>, paste the resulting tx + token info here to publish the on-chain link.
            </p>
            <Field label="Chain ID" value={chainId} onChange={setChainId} placeholder="8453" testId="input-chain" />
            <Field label="Contract address" value={contractAddress} onChange={setContractAddress} placeholder="0x…40 hex" testId="input-contract" />
            <Field label="Token ID" value={tokenId} onChange={setTokenId} placeholder="1" testId="input-token" />
            <Field label="Tx hash" value={txHash} onChange={setTxHash} placeholder="0x…64 hex" testId="input-tx" />
            <Field label="Recipient address" value={mintedToAddress} onChange={setMintedToAddress} placeholder="0x…40 hex" testId="input-to" />
            {error && <p className="text-xs text-destructive" data-testid="text-mint-error">{error}</p>}
            <button
              type="submit"
              disabled={record.isPending}
              className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              data-testid="button-record-mint"
            >
              {record.isPending ? "Recording…" : "Record mint"}
            </button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-secondary px-2 py-1.5 text-xs font-mono border border-border focus:border-primary outline-none"
        data-testid={testId}
      />
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all text-right">{value}</span>
    </div>
  );
}
