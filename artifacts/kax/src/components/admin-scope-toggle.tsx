import { useAuth } from "@workspace/replit-auth-web";

interface Props {
  showAll: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
}

export function AdminScopeToggle({ showAll, onChange, testId }: Props) {
  const { user } = useAuth();
  if (user?.role !== "admin") return null;
  return (
    <label
      className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground cursor-pointer"
      data-testid={testId ?? "toggle-scope"}
    >
      <input
        type="checkbox"
        checked={showAll}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-primary"
        data-testid={`${testId ?? "toggle-scope"}-input`}
      />
      <span>{showAll ? "All agents" : "My agents"}</span>
    </label>
  );
}
