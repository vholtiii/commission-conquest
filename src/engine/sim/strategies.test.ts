import { describe, expect, it } from "vitest";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { FamilyName } from "@/types/game";
import type { SimStrategy } from "./autoPlayer";
import { challengeLive, simulateGame, winKind, winMixNotes, writeReport, type SimResult } from "./runSim";

const STRATEGIES: SimStrategy[] = ["balanced", "racketeer", "warmonger", "expansionist", "turtle", "bootlegger", "diplomat"];
const SEEDS = [11, 29, 47, 83, 131, 173];
const HELD_OUT = [311, 433, 557, 673, 787, 907];

describe("strategy simulations", () => {
  it("plays every style across several seeds and stays on more than one path", () => {
    const games: SimResult[] = [];
    STRATEGIES.forEach((strategy, s) => {
      SEEDS.forEach((seed, i) => {
        const family = ALL_FAMILY_NAMES[(s + i) % ALL_FAMILY_NAMES.length] as FamilyName;
        games.push(simulateGame({ strategy, family, seed, difficulty: "normal", gameLength: "medium" }));
      });
    });
    const stability = games.flatMap((g) => g.problems.map((p) => `${g.strategy} ${g.family} seed ${g.seed}: ${p}`));
    const balance = winMixNotes(games);
    writeReport({ games, stability, balance }, "sim-strategies.json");

    const lines = ["strategy      wins  wealth standing turf last summit"];
    for (const strategy of STRATEGIES) {
      const rows = games.filter((g) => g.strategy === strategy && g.outcome === "won");
      const kind = (k: string) => rows.filter((g) => winKind(g.reason) === k).length;
      lines.push(
        [strategy.padEnd(13), String(rows.length).padEnd(5), String(kind("wealth")).padEnd(6), String(kind("standing")).padEnd(8), String(kind("turf")).padEnd(4), String(kind("last")).padEnd(4), String(kind("summit"))].join(" "),
      );
    }
    const heldOut: SimResult[] = [];
    STRATEGIES.forEach((strategy, s) => {
      HELD_OUT.forEach((seed, i) => {
        const family = ALL_FAMILY_NAMES[(s + i) % ALL_FAMILY_NAMES.length] as FamilyName;
        heldOut.push(simulateGame({ strategy, family, seed, difficulty: "normal", gameLength: "medium" }));
      });
    });
    const heldNotes = winMixNotes(heldOut);
    const share = (rows: SimResult[]) => {
      const row = rows.reduce((n, g) => {
        const c = challengeLive(g.challenge);
        return { live: n.live + c.live, answered: n.answered + c.answered, leaned: n.leaned + c.leanedOn, broken: n.broken + c.broken, started: n.started + c.started };
      }, { live: 0, answered: 0, leaned: 0, broken: 0, started: 0 });
      const lag = rows.reduce((n, g) => n + (g.challenge.lagWeeks ?? 0), 0);
      const why: Record<string, number> = {};
      for (const g of rows) for (const [k, v] of Object.entries(g.challenge.elsewhere ?? {})) why[k] = (why[k] ?? 0) + v;
      const busy = Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
      return `live ${row.live}, answered ${row.live ? Math.round((row.answered / row.live) * 100) : 0}% on the same track and ${row.live ? Math.round((row.leaned / row.live) * 100) : 0}% on any, started ${row.started}, broken ${row.broken}, unanswered first weeks ${lag}; rivals elsewhere: ${busy || "none"}`;
    };
    console.log(lines.join("\n"));
    console.log(`gated seeds: ${share(games)}`);
    console.log(`held-out seeds: ${share(heldOut)}`);
    if (balance.length) console.log(balance.join("\n"));
    if (heldNotes.length) console.log(`held-out notes:\n${heldNotes.join("\n")}`);
    expect(stability, stability.slice(0, 12).join("\n")).toEqual([]);
    // Standing and turf wins, and how often a live streak draws an answer, are
    // reported. The answer rate is left where the rules put it.
    const reported = (n: string) =>
      n === "standing streak never won" ||
      n === "turf streak never won" ||
      n.startsWith("answered share") ||
      n === "no streak was ever broken";
    const rest = balance.filter((n) => !reported(n));
    expect(rest, rest.join("\n")).toEqual([]);
  }, 600_000);
});
