import { useState } from "react";

interface ShareButtonsProps {
  url?: string;
  pageUrl?: string;
  title?: string;
  description?: string;
  compact?: boolean;
  inline?: boolean;
}

const LINK_ICON = (
  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);

const CHECK_ICON = (
  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

type Platform = {
  name: string;
  icon: React.ReactNode;
  getUrl: (url: string, title: string) => string | null;
  action?: "link" | "copy";
};

const PLATFORMS: Platform[] = [
  {
    name: "X",
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
    getUrl: (url, title) =>
      `https://x.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`,
  },
  {
    name: "LinkedIn",
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
      </svg>
    ),
    getUrl: (url) =>
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
  },
  {
    name: "Facebook",
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
      </svg>
    ),
    getUrl: (url) =>
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
  },
  {
    name: "Minds",
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
        <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 4.5a3 3 0 110 6 3 3 0 010-6zm0 15c-3.315 0-6-1.343-6-3v-.75C6 14.007 7.343 12.75 9 12.75h6c1.657 0 3 1.257 3 2.25V16.5c0 1.657-2.685 3-6 3z" />
      </svg>
    ),
    getUrl: (url, title) =>
      `https://www.minds.com/newsfeed/subscriptions?intentUrl=${encodeURIComponent(url)}&message=${encodeURIComponent(title)}`,
  },
  {
    name: "Copy",
    icon: LINK_ICON,
    getUrl: () => null,
    action: "copy",
  },
];

export function ShareButtons({ url, pageUrl, title, description, compact = false, inline = false }: ShareButtonsProps) {
  const [copied, setCopied] = useState(false);

  const shareUrl = url || (typeof window !== "undefined" ? window.location.href : "");
  const copyUrl = pageUrl || (typeof window !== "undefined" ? window.location.href : "");
  const shareTitle = title || "KAX - Kannaka Artifact Exchange";

  const copyToClipboard = () => {
    navigator.clipboard.writeText(copyUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleShare = (platform: Platform) => {
    if (platform.action === "copy") {
      copyToClipboard();
      return;
    }
    const shareLink = platform.getUrl(shareUrl, shareTitle);
    if (shareLink) {
      window.open(shareLink, "_blank", "noopener,noreferrer,width=600,height=400");
    }
  };

  if (compact) {
    return (
      <div className="flex items-center gap-1">
        {PLATFORMS.map((p) => (
          <button
            key={p.name}
            onClick={() => handleShare(p)}
            className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
            title={
              p.action === "copy"
                ? (copied ? "Copied!" : "Copy link")
                : `Share on ${p.name}`
            }
          >
            {p.action === "copy" && copied ? CHECK_ICON : p.icon}
          </button>
        ))}
      </div>
    );
  }

  if (inline) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground mr-1">Share</span>
        {PLATFORMS.map((p) => (
          <button
            key={p.name}
            onClick={() => handleShare(p)}
            className="w-7 h-7 flex items-center justify-center text-muted-foreground/50 hover:text-primary transition-colors"
            title={
              p.action === "copy"
                ? (copied ? "Copied!" : "Copy link")
                : `Share on ${p.name}`
            }
          >
            <span className="scale-90 flex items-center justify-center">
              {p.action === "copy" && copied ? CHECK_ICON : p.icon}
            </span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">Share</p>
      <div className="flex items-center gap-2 flex-wrap">
        {PLATFORMS.map((p) => (
          <button
            key={p.name}
            onClick={() => handleShare(p)}
            className="flex items-center gap-2 px-3 py-2 border border-border text-sm text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors"
            title={
              p.action === "copy"
                ? (copied ? "Copied!" : "Copy link")
                : `Share on ${p.name}`
            }
          >
            {p.action === "copy" && copied ? CHECK_ICON : p.icon}
            <span className="text-xs">
              {p.action === "copy" && copied ? "Copied" : p.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
