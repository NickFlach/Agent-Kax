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

function picsumFallback(id: number) {
  return `https://picsum.photos/seed/${id}/800/800`;
}

export function ArtifactCover({
  artifact,
  className = "w-full h-full",
  imgClassName = "w-full h-full object-cover",
  alt,
}: Props) {
  const { id, title, artifactType, publicUrl, thumbnailUrl } = artifact;
  const audio = isAudioType(artifactType);
  const usableThumb =
    audio && thumbnailUrl && !thumbnailUrl.includes("suno.ai") ? thumbnailUrl : null;

  if (audio && usableThumb) {
    return (
      <div className={className}>
        <img src={usableThumb} alt={alt ?? title} className={imgClassName} />
      </div>
    );
  }

  if (audio) {
    return (
      <div className={className}>
        <AudioCover title={title} />
      </div>
    );
  }

  return (
    <div className={className}>
      <img
        src={publicUrl ?? picsumFallback(id)}
        alt={alt ?? title}
        className={imgClassName}
        onError={(e) => {
          const el = e.target as HTMLImageElement;
          if (!el.src.startsWith("https://picsum.photos/")) {
            el.src = picsumFallback(id);
          }
        }}
      />
    </div>
  );
}
