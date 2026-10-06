import { useState } from "react";
import { Building2, Car, Crosshair, Flame, ChevronDown, ChevronUp, MapPin, Crown, Eye, ShieldOff } from "lucide-react";
import { FAMILY_HEX, MAP_STATUS, type FamilyName } from "@/types/game";
import { BOROUGH_HEX, BOROUGH_ORDER } from "@/data/boroughs";

const FAMILIES: FamilyName[] = ["Moretti", "Valenti", "Ferraro", "Salvati", "Rinaldi"];

export default function MapLegend() {
  const [open, setOpen] = useState(true);

  return (
    <div className="pointer-events-auto absolute bottom-4 left-4 z-30 w-56 rounded-md border border-panel-border bg-panel/90 text-xs shadow-lg backdrop-blur-sm">
      <button
        className="flex w-full items-center justify-between px-3 py-2 font-ui text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        Map Legend
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
      </button>
      {open && (
        <div className="space-y-2 border-t border-panel-border px-3 py-2">
          <div className="space-y-1 text-muted-foreground">
            <div className="text-[10px] uppercase tracking-wide">Camera</div>
            <div>Left-drag: pan · Wheel: zoom</div>
            <div>Right-drag or Shift+drag: rotate</div>
          </div>
          <div className="space-y-1.5 border-t border-panel-border/60 pt-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Markers</div>
            <div className="flex items-center gap-2">
              <span className="flex h-4 w-4 items-center justify-center rounded-[2px] border border-white/40 bg-[#3a3d44]">
                <MapPin className="h-2.5 w-2.5 text-white/70" />
              </span>
              District / unclaimed
            </div>
            <div className="flex items-center gap-2">
              <span className="h-4 w-4 rounded-full border-2 border-steel-light bg-[#2a2d33]" />
              Your crew
            </div>
            <div className="flex items-center gap-2">
              <span
                className="h-3 w-3 border-2 border-white/70 bg-[#2a2d33]"
                style={{ transform: "rotate(45deg)" }}
              />
              Rival (only if known / HQ)
            </div>
            <div className="flex items-center gap-2">
              <Crown className="h-3.5 w-3.5 text-amber-300" /> Rival HQ
            </div>
            <div className="flex items-center gap-2">
              <Car className="h-3.5 w-3.5 text-white/80" /> Boss's car — where he is; his face needs intel
            </div>
            <div className="flex items-center gap-2">
              <Eye className="h-3.5 w-3.5 text-sky-300" /> Active intel on district
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="h-4 w-4 rounded-[2px] border-2 border-[#2E6EB5] bg-[#2E6EB5]/30" />
              Colored square, no portrait = unknown presence
            </div>
          </div>
          <div className="space-y-1 border-t border-panel-border/60 pt-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Family turf (color)
            </div>
            {FAMILIES.map((f) => (
              <div key={f} className="flex items-center gap-2">
                <span
                  className="h-3 w-3 rounded-[2px] border border-white/20"
                  style={{ background: FAMILY_HEX[f] }}
                />
                <span>{f}</span>
              </div>
            ))}
          </div>
          <div className="space-y-1.5 border-t border-panel-border/60 pt-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Status (not family colors)
            </div>
            <div className="flex items-center gap-2">
              <span className="relative h-4 w-4">
                <span
                  className="absolute left-0 top-0 h-1.5 w-1.5 border-l-2 border-t-2"
                  style={{ borderColor: MAP_STATUS.vendetta }}
                />
                <span
                  className="absolute right-0 top-0 h-1.5 w-1.5 border-r-2 border-t-2"
                  style={{ borderColor: MAP_STATUS.vendetta }}
                />
                <span
                  className="absolute bottom-0 left-0 h-1.5 w-1.5 border-b-2 border-l-2"
                  style={{ borderColor: MAP_STATUS.vendetta }}
                />
                <span
                  className="absolute bottom-0 right-0 h-1.5 w-1.5 border-b-2 border-r-2"
                  style={{ borderColor: MAP_STATUS.vendetta }}
                />
              </span>
              Vendetta (cyan brackets)
            </div>
            <div className="flex items-center gap-2">
              <span
                className="relative flex h-4 w-4 items-center justify-center rounded-[2px] border-2"
                style={{ borderColor: MAP_STATUS.hitPending }}
              >
                <Crosshair className="h-2.5 w-2.5" style={{ color: MAP_STATUS.hitPending }} />
              </span>
              Pending hit (magenta reticle)
            </div>
            <div className="flex items-center gap-2">
              <span
                className="relative flex h-4 w-4 items-center justify-center rounded-[2px] border-2 border-dashed"
                style={{ borderColor: MAP_STATUS.hitPreview }}
              >
                <Crosshair className="h-2.5 w-2.5" style={{ color: MAP_STATUS.hitPreview }} />
              </span>
              Hit aim preview
            </div>
          </div>
          <div className="space-y-1.5 border-t border-panel-border/60 pt-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Strategic view
            </div>
            <div className="flex items-center gap-2">
              <span className="h-4 w-4 rounded-[2px] border border-[#3a3d44] bg-[#23262c]" />
              Unknown district
            </div>
            <div className="flex items-center gap-2">
              <span
                className="relative h-4 w-4 overflow-hidden rounded-[2px] border border-[#7a7f87]/70"
                style={{
                  background:
                    "repeating-linear-gradient(-45deg, transparent, transparent 2px, #9aa0a855 2px, #9aa0a855 3px)",
                }}
              />
              Unclaimed (hatched)
            </div>
            <div className="flex items-center gap-2">
              <Crown className="h-3.5 w-3.5 text-amber-300" /> Family HQ / boss
            </div>
            <div className="pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              Boroughs
            </div>
            {BOROUGH_ORDER.map((b) => (
              <div key={b} className="flex items-center gap-2">
                <span
                  className="h-3 w-3 rounded-[2px] border border-white/20"
                  style={{ background: BOROUGH_HEX[b] }}
                />
                <span>{b}</span>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <span className="inline-block h-0.5 w-3.5 bg-[#e8e2d0]/80" />
              Light line = borough boundary
            </div>
          </div>
          <div className="space-y-1 border-t border-panel-border/60 pt-2 text-muted-foreground">
            <div className="flex items-center gap-2">
              <Building2 className="h-3.5 w-3.5 text-steel-light" /> Racket / business
            </div>
            <div className="flex items-center gap-2">
              <span className="flex h-4 w-4 items-center justify-center rounded-full border-2 border-amber-400 bg-amber-900/80">
                <Building2 className="h-2.5 w-2.5 text-amber-200" />
              </span>
              Big block (5+ slots)
            </div>
            <div className="flex items-center gap-2">
              <ShieldOff className="h-3.5 w-3.5 text-heat" /> Unguarded rackets
            </div>
            <div className="flex items-center gap-2">
              <Flame className="h-3.5 w-3.5 text-heat" /> High heat
            </div>
            <div className="flex items-center gap-2">
              <Car className="h-3.5 w-3.5 text-amber-400" /> Hit team departing
            </div>
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-0.5 w-3.5 border-t-2 border-dashed"
                style={{ borderColor: MAP_STATUS.hitPending }}
              />{" "}
              Pending hit route
            </div>
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-0.5 w-3.5 border-t-2 border-dotted"
                style={{ borderColor: MAP_STATUS.supplyRoute }}
              />{" "}
              Supply route — ring at the start, arrow at the stop
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
