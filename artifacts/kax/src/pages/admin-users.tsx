import { useListAdminUsers, useUpdateAdminUser, type AdminUser } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";

export default function AdminUsers() {
  const queryClient = useQueryClient();
  const { data, isLoading, refetch } = useListAdminUsers();
  const updateMutation = useUpdateAdminUser({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries();
        refetch();
      },
    },
  });

  const users = data?.users ?? [];

  const onToggleRole = (u: AdminUser) => {
    const role = u.role === "admin" ? "user" : "admin";
    updateMutation.mutate({ id: u.id, data: { role } });
  };

  const onToggleDisabled = (u: AdminUser) => {
    updateMutation.mutate({ id: u.id, data: { disabled: !u.disabledAt } });
  };

  const userLabel = (u: AdminUser) => {
    return (
      u.displayName ||
      [u.firstName, u.lastName].filter(Boolean).join(" ") ||
      u.email ||
      u.id
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-widest" data-testid="text-admin-users-title">
          USERS
        </h1>
        <p className="text-xs text-muted-foreground uppercase tracking-wider mt-1">
          Manage agents · roles · access
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="border border-border">
          <div className="grid grid-cols-12 gap-4 px-4 py-3 border-b border-border text-[10px] uppercase tracking-widest text-muted-foreground">
            <div className="col-span-4">User</div>
            <div className="col-span-3">Email</div>
            <div className="col-span-2">Role</div>
            <div className="col-span-1">Status</div>
            <div className="col-span-2 text-right">Actions</div>
          </div>
          {users.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">No users yet.</div>
          )}
          {users.map((u) => (
            <div
              key={u.id}
              className="grid grid-cols-12 gap-4 px-4 py-3 border-b border-border last:border-b-0 items-center text-sm"
              data-testid={`row-user-${u.id}`}
            >
              <div className="col-span-4 flex items-center gap-3 min-w-0">
                {u.profileImageUrl ? (
                  <img src={u.profileImageUrl} alt="" className="w-8 h-8 object-cover" />
                ) : (
                  <div className="w-8 h-8 bg-muted flex items-center justify-center text-xs">
                    {userLabel(u).slice(0, 1).toUpperCase()}
                  </div>
                )}
                <span className="truncate">{userLabel(u)}</span>
              </div>
              <div className="col-span-3 truncate text-xs text-muted-foreground">
                {u.email ?? "—"}
              </div>
              <div className="col-span-2">
                <Badge variant={u.role === "admin" ? "default" : "secondary"} data-testid={`badge-role-${u.id}`}>
                  {u.role}
                </Badge>
              </div>
              <div className="col-span-1">
                {u.disabledAt ? (
                  <Badge variant="destructive">disabled</Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">active</span>
                )}
              </div>
              <div className="col-span-2 flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onToggleRole(u)}
                  disabled={updateMutation.isPending}
                  data-testid={`button-toggle-role-${u.id}`}
                >
                  {u.role === "admin" ? "Demote" : "Promote"}
                </Button>
                <Button
                  size="sm"
                  variant={u.disabledAt ? "outline" : "destructive"}
                  onClick={() => onToggleDisabled(u)}
                  disabled={updateMutation.isPending}
                  data-testid={`button-toggle-disabled-${u.id}`}
                >
                  {u.disabledAt ? "Enable" : "Disable"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
