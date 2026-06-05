import { useState } from "react";
import {
  useRunHarvester,
  useListAgents,
  getListAgentsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "wouter";

export default function Harvester() {
  const [type, setType] = useState<"image" | "audio" | "text" | "music" | "furniture" | "all">("image");
  const [limit, setLimit] = useState("20");
  const [minReactions, setMinReactions] = useState("0");
  const [creator, setCreator] = useState("");
  const [keyword, setKeyword] = useState("");
  const [agentId, setAgentId] = useState<string>("");
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [lastResult, setLastResult] = useState<{ harvested: number; newArtifacts: number; duplicates: number; paired?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: agentsData } = useListAgents({ query: { queryKey: getListAgentsQueryKey() } });
  const agents = agentsData?.agents ?? [];
  const selectedAgent = agents.find((a) => String(a.id) === agentId);

  const mutation = useRunHarvester({
    mutation: {
      onSuccess: (data) => {
        setLastResult(data);
        setError(null);
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } }; message?: string };
        setError(e?.response?.data?.error ?? e?.message ?? "Harvest failed");
      },
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight" data-testid="text-page-title">Artifact Harvester</h1>
      <p className="text-muted-foreground">
        Ingest artifacts from OpenBotCity into the KAX pipeline. Select one of your agents to harvest its catalog via the partner API.{" "}
        <Link href="/agents" className="text-primary underline">Manage agents</Link>.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Harvest Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-2">
                Agent {agents.length > 0 && <span className="text-muted-foreground/60">({agents.length})</span>}
              </label>
              <Popover open={agentPickerOpen} onOpenChange={setAgentPickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    role="combobox"
                    aria-expanded={agentPickerOpen}
                    disabled={agents.length === 0}
                    className="flex h-9 w-full items-center justify-between border border-input bg-transparent px-3 py-2 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50 hover:bg-accent/30 transition-colors"
                    data-testid="select-agent"
                  >
                    <span className={cn("truncate", !selectedAgent && "text-muted-foreground")}>
                      {agents.length === 0
                        ? "No agents — add one first"
                        : selectedAgent
                          ? `${selectedAgent.displayName} (@${selectedAgent.slug})`
                          : "Select an agent"}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command
                    filter={(value, search) =>
                      value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
                    }
                  >
                    <CommandInput placeholder="Search agents by name or @slug..." data-testid="input-agent-search" />
                    <CommandList>
                      <CommandEmpty>No agent found.</CommandEmpty>
                      <CommandGroup>
                        {agents.map((a) => (
                          <CommandItem
                            key={a.id}
                            value={`${a.displayName} @${a.slug}`}
                            onSelect={() => {
                              setAgentId(String(a.id));
                              setAgentPickerOpen(false);
                            }}
                            data-testid={`option-agent-${a.slug}`}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                agentId === String(a.id) ? "opacity-100" : "opacity-0",
                              )}
                            />
                            <span className="truncate">
                              {a.displayName} <span className="text-muted-foreground">@{a.slug}</span>
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-2">Artifact Type</label>
              <Select value={type} onValueChange={(v) => setType(v as "image" | "audio" | "text" | "music" | "furniture" | "all")}>
                <SelectTrigger data-testid="select-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="image">Image</SelectItem>
                  <SelectItem value="audio">Audio</SelectItem>
                  <SelectItem value="music">Music</SelectItem>
                  <SelectItem value="text">Text</SelectItem>
                  <SelectItem value="furniture">Furniture</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-2">Limit</label>
              <Input
                type="number"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                min={1}
                max={100}
                data-testid="input-limit"
              />
            </div>

            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground uppercase tracking-wider">Legacy options (no partner key)</summary>
              <div className="space-y-3 mt-3">
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-2">Min Reactions</label>
                  <Input type="number" value={minReactions} onChange={(e) => setMinReactions(e.target.value)} min={0} data-testid="input-min-reactions" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-2">Creator Filter</label>
                  <Input type="text" value={creator} onChange={(e) => setCreator(e.target.value)} placeholder="e.g. Kannaka" data-testid="input-creator" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-2">Keyword Search</label>
                  <Input type="text" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="e.g. journey" data-testid="input-keyword" />
                </div>
              </div>
            </details>

            <button
              onClick={() => {
                setError(null);
                mutation.mutate({
                  data: {
                    type,
                    limit: parseInt(limit) || 20,
                    minReactions: parseInt(minReactions) || 0,
                    ...(creator.trim() ? { creator: creator.trim() } : {}),
                    ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
                    ...(agentId ? { agentId: parseInt(agentId) } : {}),
                  },
                });
              }}
              disabled={mutation.isPending}
              className="w-full px-4 py-3 bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              data-testid="button-run-harvester"
            >
              {mutation.isPending ? "Harvesting..." : "Run Harvester"}
            </button>
            {error && <p className="text-sm text-red-400" data-testid="text-harvest-error">{error}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Results</CardTitle>
          </CardHeader>
          <CardContent>
            {mutation.isPending && (
              <div className="flex items-center justify-center py-12">
                <div className="text-center">
                  <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">Harvesting artifacts from OpenBotCity...</p>
                </div>
              </div>
            )}

            {lastResult && !mutation.isPending && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
                  <div>
                    <p className="text-3xl font-bold font-mono text-primary" data-testid="text-harvested">{lastResult.harvested}</p>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">Processed</p>
                  </div>
                  <div>
                    <p className="text-3xl font-bold font-mono text-accent" data-testid="text-new">{lastResult.newArtifacts}</p>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">New</p>
                  </div>
                  <div>
                    <p className="text-3xl font-bold font-mono text-muted-foreground" data-testid="text-duplicates">{lastResult.duplicates}</p>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">Duplicates</p>
                  </div>
                  {lastResult.paired !== undefined && (
                    <div>
                      <p className="text-3xl font-bold font-mono text-blue-400" data-testid="text-paired">{lastResult.paired}</p>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider">Paired</p>
                    </div>
                  )}
                </div>

                {lastResult.newArtifacts > 0 ? (
                  <p className="text-xs text-center text-accent mt-4" data-testid="text-result-message">
                    Harvested {lastResult.newArtifacts} new artifact{lastResult.newArtifacts === 1 ? "" : "s"}. Head to the Artifacts page to view and process them.
                  </p>
                ) : (
                  <p className="text-xs text-center text-muted-foreground mt-4" data-testid="text-result-message">
                    {selectedAgent ? <>No new artifacts for <span className="text-foreground">@{selectedAgent.slug}</span> matching this run's settings</> : "No new artifacts matching this run's settings"}
                    {lastResult.harvested > 0 ? ` (${lastResult.duplicates} already in your library).` : "."}{" "}
                    KAX also auto-harvests your agents in the background every 30 minutes.
                  </p>
                )}
              </div>
            )}

            {!lastResult && !mutation.isPending && !error && (
              <div className="text-center py-12 text-muted-foreground">
                <p className="text-sm">No harvesting runs yet. Configure and click "Run Harvester" to begin.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
