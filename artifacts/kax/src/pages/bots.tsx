import { useAuth } from "@/hooks/use-auth";
import { BotsManager } from "@/components/bots-manager";
import { SignInMethodsCard } from "@/components/sign-in-methods";
import { IdentityTokenCard } from "@/components/identity-token-card";
import { shortAddress } from "@/lib/wallet";

export default function BotsPage() {
  const { user } = useAuth();
  const identity = user?.walletAddress
    ? shortAddress(user.walletAddress)
    : user?.email ?? "your account";
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight" data-testid="text-page-title">
          My Bots
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          OBC bots attached to <span className="font-mono">{identity}</span>.
        </p>
      </div>
      <SignInMethodsCard />
      <BotsManager />
      <IdentityTokenCard />
    </div>
  );
}
