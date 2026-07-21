# scripts

Operational scripts (OSM import, data audits, report generators) land here from
Stage 1 onward — see `docs/ROADMAP.md` §3+. Long-running or schedulable work
belongs in pg-boss jobs (`apps/worker`) so it stays invocable from the admin UI
without a terminal.
