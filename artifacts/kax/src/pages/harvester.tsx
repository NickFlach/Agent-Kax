import { useState } from "react";
import { useRunHarvester } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function Harvester() {
  const [type, setType] = useState<"image" | "music" | "text">("image");
  const [limit, setLimit] = useState("20");
  const [minReactions, setMinReactions] = useState("0");
  const [creator, setCreator] = useState("");
  const [lastResult, setLastResult] = useState<{ harvested: number; newArtifacts: number; duplicates: number } | null>(null);

  const mutation = useRunHarvester({
    mutation: {
      onSuccess: (data) => {
        setLastResult(data);
      },
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight" data-testid="text-page-title">Artifact Harvester</h1>
      <p className="text-muted-foreground">Ingest artifacts from the OpenBotCity public gallery into the KAX pipeline.</p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Harvest Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-2">Artifact Type</label>
              <Select value={type} onValueChange={(v) => setType(v as "image" | "music" | "text")}>
                <SelectTrigger data-testid="select-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="image">Image</SelectItem>
                  <SelectItem value="music">Music</SelectItem>
                  <SelectItem value="text">Text</SelectItem>
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

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-2">Min Reactions</label>
              <Input
                type="number"
                value={minReactions}
                onChange={(e) => setMinReactions(e.target.value)}
                min={0}
                data-testid="input-min-reactions"
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-2">Creator Filter</label>
              <Input
                type="text"
                value={creator}
                onChange={(e) => setCreator(e.target.value)}
                placeholder="e.g. Kannaka (leave empty for all)"
                data-testid="input-creator"
              />
            </div>

            <button
              onClick={() => {
                mutation.mutate({
                  data: {
                    type,
                    limit: parseInt(limit) || 20,
                    minReactions: parseInt(minReactions) || 0,
                    ...(creator.trim() ? { creator: creator.trim() } : {}),
                  },
                });
              }}
              disabled={mutation.isPending}
              className="w-full px-4 py-3 bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              data-testid="button-run-harvester"
            >
              {mutation.isPending ? "Harvesting..." : "Run Harvester"}
            </button>
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
                <div className="grid grid-cols-3 gap-4 text-center">
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
                </div>
                <p className="text-xs text-center text-muted-foreground mt-4">
                  Head to the Artifacts page to view and process the harvested items.
                </p>
              </div>
            )}

            {!lastResult && !mutation.isPending && (
              <div className="text-center py-12 text-muted-foreground">
                <p className="text-sm">No harvesting runs yet. Configure and click "Run Harvester" to begin.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Pipeline Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 overflow-x-auto text-xs">
            <Step label="Harvest" desc="Ingest from OpenBotCity" active />
            <Arrow />
            <Step label="Score" desc="Taste Engine evaluation" />
            <Arrow />
            <Step label="Narrate" desc="Story transformation" />
            <Arrow />
            <Step label="Drop" desc="Bundle for sale" />
            <Arrow />
            <Step label="Publish" desc="Launch to storefront" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Step({ label, desc, active }: { label: string; desc: string; active?: boolean }) {
  return (
    <div className={`flex-shrink-0 px-4 py-3 border ${active ? "border-primary bg-primary/10" : "border-border"}`}>
      <p className={`font-medium ${active ? "text-primary" : ""}`}>{label}</p>
      <p className="text-muted-foreground mt-0.5">{desc}</p>
    </div>
  );
}

function Arrow() {
  return <span className="text-muted-foreground flex-shrink-0">→</span>;
}
