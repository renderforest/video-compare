# CLAUDE.md

Node ≥ 22, ESM, no semicolons, single quotes, 2-space indent (same style as `s2s-compare`).
No build step, no TypeScript. State in `data/` (SQLite `data/eval.sqlite`, videos in `data/outputs`, `data/prod`, `data/inputs`), all git-ignored.

- `npm run serve` — API + review UI (`public/index.html`, single file, vanilla JS). `npm test` — node:test unit tests.
- Production facts the code mirrors live in `docs/plan.md`; size tables in `src/dims.js` are copied from `ai-workers-service/src/core/config/config.js` (origin/main). Keep them in sync if the worker changes.
- Generation is strictly sequential on purpose (one GPU). Do not add concurrency.
- Workflows are raw ComfyUI API exports; `src/workflow.js#detectBindings` finds injection points by class/title. When a new node type shows up in a candidate graph, extend the detection there rather than asking users to edit JSON.
- The ComfyUI instance on gen22 (`127.0.0.1:8188`) is shared with the production image worker; expect our prompts to queue behind image jobs.
- Deploy: `deploy/deploy.sh` (tar over ssh, key `~/.ssh/ai`), unit file in `deploy/video-compare.service`. Local dev against gen22: `ssh -i ~/.ssh/ai -o IdentitiesOnly=yes -p 22001 -f -N -L 18188:localhost:8188 node@69.197.165.120` then `COMFY_URL=http://127.0.0.1:18188`.
