import { useState } from "react";
import { FileText, ImageOff } from "lucide-react";
import { AudioCover } from "@/components/audio-cover";

export interface ArtifactCoverData {
  id: number;
  title: string;
  artifactType: string;
  publicUrl?: string | null;
  thumbnailUrl?: string | null;
}

interface Props {
  artifact: ArtifactCoverData;
  className?: string;
  imgClassName?: string;
  alt?: string;
}

const isAudioType = (t: string) => t === "audio" || t === "music";
const isTextType = (t: string) => t === "text";

/**
 * Only http(s) URLs are real images. The OBC partner feed uses sentinel
 * values like `inline:text` for non-visual artifacts (text, etc.), which must
 * never be rendered as an <img> — doing so previously triggered an onError
 * fallback to a RANDOM picsum.photos stock photo, surfacing "AI photos" that
 * have nothing to do with the artifact.
 */
function isUsableImageUrl(url?: string | null): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

function TextCover({ title }: { title: string }) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-gradient-to-br from-secondary to-background p-4 text-center">
      <FileText className="w-8 h-8 text-primary/70" strokeWidth={1.5} />
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary/60">
        Text Transmission
      </p>
      <p className="font-bold text-sm text-foreground/90 line-clamp-4">{title}</p>
    </div>
  );
}

function PlaceholderCover({ title }: { title: string }) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-secondary p-4 text-center">
      <ImageOff className="w-7 h-7 text-muted-foreground/60" strokeWidth={1.5} />
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        No Preview
      </p>
      <p className="font-bold text-xs text-foreground/70 line-clamp-3">{title}</p>
    </div>
  );
}

function ImageCover({
  src,
  title,
  alt,
  imgClassName,
}: {
  src: string;
  title: string;
  alt?: string;
  imgClassName: string;
}) {
  const [errored, setErrored] = useState(false);
  if (errored) return <PlaceholderCover title={title} />;
  return (
    <img
      src={src}
      alt={alt ?? title}
      className={imgClassName}
      onError={() => setErrored(true)}
    />
  );
}

export function ArtifactCover({
  artifact,
  className = "w-full h-full",
  imgClassName = "w-full h-full object-cover",
  alt,
}: Props) {
  const { title, artifactType, publicUrl, thumbnailUrl } = artifact;

  if (isAudioType(artifactType)) {
    const usableThumb =
      isUsableImageUrl(thumbnailUrl) && !thumbnailUrl.includes("suno.ai")
        ? thumbnailUrl
        : null;
    return (
      <div className={className}>
        {usableThumb ? (
          <img src={usableThumb} alt={alt ?? title} className={imgClassName} />
        ) : (
          <AudioCover title={title} />
        )}
      </div>
    );
  }

  if (isTextType(artifactType)) {
    return (
      <div className={className}>
        <TextCover title={title} />
      </div>
    );
  }

  // image / furniture / unknown visual types.
  const src = isUsableImageUrl(publicUrl)
    ? publicUrl
    : isUsableImageUrl(thumbnailUrl)
      ? thumbnailUrl
      : null;

  return (
    <div className={className}>
      {src ? (
        <ImageCover src={src} title={title} alt={alt} imgClassName={imgClassName} />
      ) : (
        <PlaceholderCover title={title} />
      )}
    </div>
  );
}
