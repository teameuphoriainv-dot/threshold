# THRESHOLD

A non-Euclidean multiplayer horror game where an LLM-powered entity hunts you through a shifting Upside Down. It learns how you talk, wears your friends' voices, and reshapes the world to break your trust in each other.

> SpacetimeDB Launchpad Hackathon · #NYTechWeek · ~42h

## Play the slice right now

No install. Open the file in a browser:

- **`index.html`** — the playable vertical slice. Find 3 anchors, carry them to the convergence ring, escape. The Warden forges chat messages from teammates you can't see — line-of-sight is the only thing that exposes them. Includes seamless teleport portals (loops + "bigger on the inside") and corridors that rewrite themselves while you aren't looking.
- **`hyperbolic-spike.html`** — true hyperbolic-geometry renderer (hyperboloid / Minkowski model, Lorentz-boost movement), modeled on [HackerPoet/HyperEngine](https://github.com/HackerPoet/HyperEngine) (the Unity backend for CodeParade's *Hyperbolica*, MIT). The wow-factor track for the non-Euclidean world.

```bash
# any static server works, e.g.
python3 -m http.server 8000
# then open http://localhost:8000/index.html
```

## The core mechanic (the pitch)

If you can **see** a teammate, their messages are guaranteed real (they glow warm). If you **can't**, any message bearing their name might be the Warden wearing their voice. Staying together is safe but slow; splitting up is fast but everything anyone says becomes unverifiable. The Warden's whole job is to make splitting attractive, then exploit it.

## What's real here vs. the full build

This is a **single-file, no-backend slice** that proves the soul of the design. The 42h build swaps in:

- **Bots → real players** synced via **SpacetimeDB** tables/reducers.
- **Local rule-based Warden → a privileged Node client** that subscribes to game state and calls an **LLM** for forged-message text (few-shot from each player's real messages).
- **`forged` flag → a server-only column** hidden from clients by subscription filtering.

Hook points are marked in code with `>>> SPACETIME` and `>>> LLM`.

See `PRD.md` (team doc) for the full design, scope tiers, and demo script.

## Stack (target)

Vite · React + TypeScript · React Three Fiber + Drei + postprocessing · Tailwind/shadcn · SpacetimeDB (TS modules) · Node + LLM API for the Warden.

## Team

Dhruv Jain (lead) · Sriyan Bodla · Aarya Mani · Mounish Mavuduru
