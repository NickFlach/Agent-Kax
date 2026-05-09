import { useEffect, useState } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { useUpdateNotificationPrefs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/hooks/use-toast";

export function NotificationPrefsCard() {
  const { user } = useAuth();
  const initial = user?.notificationPrefs ?? { emailOnProposal: false, emailOnDm: false };
  const [emailOnProposal, setEmailOnProposal] = useState(initial.emailOnProposal);
  const [emailOnDm, setEmailOnDm] = useState(initial.emailOnDm);
  const hydrated = !!user;

  useEffect(() => {
    if (user?.notificationPrefs) {
      setEmailOnProposal(user.notificationPrefs.emailOnProposal);
      setEmailOnDm(user.notificationPrefs.emailOnDm);
    }
  }, [user]);

  const update = useUpdateNotificationPrefs({
    mutation: {
      onSuccess: (data) => {
        setEmailOnProposal(data.emailOnProposal);
        setEmailOnDm(data.emailOnDm);
        toast({ title: "Preferences saved" });
      },
      onError: (_err, variables) => {
        const data = variables.data;
        if (data.emailOnProposal !== undefined) {
          setEmailOnProposal(!data.emailOnProposal);
        }
        if (data.emailOnDm !== undefined) {
          setEmailOnDm(!data.emailOnDm);
        }
        toast({ title: "Could not save preferences", description: "Please try again." });
      },
    },
  });

  if (!hydrated) return null;
  const hasEmail = !!user?.email;

  function toggle(field: "emailOnProposal" | "emailOnDm", value: boolean) {
    if (field === "emailOnProposal") setEmailOnProposal(value);
    else setEmailOnDm(value);
    update.mutate({ data: { [field]: value } });
  }

  return (
    <Card data-testid="notification-prefs-card">
      <CardHeader>
        <CardTitle className="text-base uppercase tracking-wider">Email Notifications</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasEmail && (
          <p className="text-xs text-muted-foreground">
            Add an email to your account to receive notifications.
          </p>
        )}
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Email me when a new proposal arrives</span>
          <input
            type="checkbox"
            checked={emailOnProposal}
            disabled={!hasEmail || update.isPending}
            onChange={(e) => toggle("emailOnProposal", e.target.checked)}
            data-testid="toggle-email-on-proposal"
            className="h-4 w-4 accent-primary"
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Email me when a new DM arrives</span>
          <input
            type="checkbox"
            checked={emailOnDm}
            disabled={!hasEmail || update.isPending}
            onChange={(e) => toggle("emailOnDm", e.target.checked)}
            data-testid="toggle-email-on-dm"
            className="h-4 w-4 accent-primary"
          />
        </label>
        <p className="text-[11px] text-muted-foreground">
          You'll always see new proposals and DMs in the Inbox and Proposals tabs.
        </p>
      </CardContent>
    </Card>
  );
}
