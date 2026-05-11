import { useAuth } from "@/hooks/use-auth";
import { BotsManager } from "@/components/bots-manager";
import { shortAddress } from "@/lib/wallet";

export default function BotsPage() {
  const { user } = useAuth();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight" data-testid="text-page-title">
          My Bots
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          OBC bots attached to{" "}
          <span className="font-mono">
            {user?.walletAddress ? shortAddress(user.walletAddress) : "your account"}
          </span>
          .
        </p>
      </div>
      <BotsManager />
    </div>
  );
}
