import { useMemo, useState } from "react";
import { portraitForCrew } from "@/data/portraits";

interface PortraitAvatarProps {
  seed: number;
  size?: number;
  ringColor?: string | null;
  className?: string;
  role?: string;
  family?: string;
  isPlayerBoss?: boolean;
  alt?: string;
}

/** Photorealistic portrait — seeded crew pack or dedicated boss art.
 *  Default shape is a circle; pass `shape="square"` for district-adjacent UI if needed.
 */
export default function PortraitAvatar({
  seed,
  size = 40,
  ringColor,
  className,
  role,
  family,
  isPlayerBoss,
  alt = "Portrait",
  shape = "circle",
}: PortraitAvatarProps & { shape?: "circle" | "square" }) {
  const src = useMemo(
    () => portraitForCrew({ seed, role, family, isPlayerBoss }),
    [seed, role, family, isPlayerBoss],
  );
  const [failed, setFailed] = useState(false);
  const borderWidth = ringColor === "transparent" ? 0 : 2;

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: shape === "square" ? 4 : "50%",
        overflow: "hidden",
        border: borderWidth ? `${borderWidth} solid ${ringColor ?? "#5c5c5c"}` : "none",
        background: "#1a1b1e",
        flexShrink: 0,
        boxShadow: borderWidth ? "inset 0 0 0 1px rgba(0,0,0,0.35)" : undefined,
      }}
    >
      {!failed ? (
        <img
          src={src}
          alt={alt}
          width={size}
          height={size}
          loading="lazy"
          onError={() => setFailed(true)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center 20%",
            display: "block",
            filter: "contrast(1.05) saturate(0.92)",
          }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "linear-gradient(145deg,#2a2d33,#16181c)",
            color: "#9aa3ad",
            fontSize: Math.max(10, size * 0.32),
            fontWeight: 700,
          }}
        >
          ?
        </div>
      )}
    </div>
  );
}
