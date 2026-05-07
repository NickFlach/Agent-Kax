interface EditionBadgeProps {
  editionType: "open" | "limited" | "1_of_1" | string;
  editionTotal?: number | null;
  editionSerial?: number | null;
  className?: string;
}

export function EditionBadge({ editionType, editionTotal, editionSerial, className = "" }: EditionBadgeProps) {
  let label = "OPEN";
  let style = "bg-muted/80 text-muted-foreground border-muted-foreground/30";

  if (editionType === "1_of_1") {
    label = "1 OF 1";
    style = "bg-accent/20 text-accent border-accent/60";
  } else if (editionType === "limited") {
    if (editionSerial != null && editionTotal != null) {
      label = `EDITION ${editionSerial} / ${editionTotal}`;
    } else if (editionTotal != null) {
      label = `LIMITED / ${editionTotal}`;
    } else {
      label = "LIMITED";
    }
    style = "bg-primary/20 text-primary border-primary/60";
  }

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] font-mono font-bold tracking-widest border ${style} ${className}`}
      data-testid="badge-edition"
    >
      {label}
    </span>
  );
}
