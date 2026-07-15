# SAP Claim App Suite (Claudelink)

Single-file launcher (`index.html`) that embeds three standalone HTML apps
and switches between them in an iframe. Deployed via GitHub Pages at
https://sitthikraiwong123-lab.github.io/Claudelink/

## Structure

```
index.html              generated — do NOT edit by hand
index.template.html     launcher shell with {{GASOLINE}} {{CLAIM}} {{WARRANTY}} placeholders
build.py                assembles index.html from index.template.html + apps/*.html
apps/
  gasoline.html          Gasoline — Fix Cash Advance app (source lives here)
  claim_manager.html      Cash Advance / Claim Manager app (source lives here)
sync_warranty.py         pulls Warranty from the external warranty-app repo
                          and patches it directly into index.html
```

Note: there is **no `apps/warranty.html`**. Warranty's source of truth is
the separate repo `https://github.com/sitthikraiwong123-lab/warranty-app.git`
(file `Warranty App.html` at its root) — it is intentionally not mirrored
here to avoid two copies going stale relative to each other.

`build.py` reads `apps/gasoline.html` and `apps/claim_manager.html`,
escapes `</script>` as `<\/script>` (the launcher's `unesc()` reverses this
at runtime), and substitutes them into the matching placeholders in
`index.template.html` to produce `index.html`. Since there is no
`apps/warranty.html`, `build.py` leaves the existing `src-warranty` block in
`index.html` untouched when it runs — it never wipes out warranty content,
it just doesn't refresh it.

## Update workflow

**Gasoline / Claim Manager** — when the user says "update gasoline" /
"update claim" with a new file attached:

1. Replace `apps/gasoline.html` or `apps/claim_manager.html` with the new
   version.
2. Run `python3 build.py` to regenerate `index.html`.
3. Verify: `git diff --stat` should only touch `index.html` and the changed
   `apps/*.html` file — nothing else.
4. Commit and push to `main`.

**Warranty** — when the user says "update warranty" (no attachment needed
— it's pulled from the warranty-app repo, not from chat):

1. `add_repo` (if not already added this session) + clone/fetch
   `sitthikraiwong123-lab/warranty-app`, then `git reset --hard origin/main`
   the local clone to pick up the latest push.
2. Run `python3 sync_warranty.py <path-to-warranty-app-clone>` — this reads
   `Warranty App.html` from the clone and patches `index.html`'s
   `src-warranty` block in place. Do **not** write to `apps/warranty.html`
   (it should not exist) and do not run `build.py` for this — they're
   independent paths.
3. Verify: `git diff --stat` should only touch `index.html`.
4. Commit and push to `main`.

"update ทั้งหมด" / "update all" — do the gasoline/claim steps (if new files
were attached) and the warranty sync, then commit together or separately.

Do not hand-edit `index.html` directly — always go through `build.py` /
`sync_warranty.py` so changes are traceable and reproducible.

## Notes

- `main` branch history includes an old unrelated root (the former
  standalone warranty-app mirror) preserved via a merge commit — this is
  expected, not a mistake.
- The `warranty-app` repo's history has been force-pushed/rewritten before
  (its root commit hash has changed at least once) — always re-fetch rather
  than assuming a previously cloned copy is current.
- Multiple sessions/chats may work on this repo concurrently (same GitHub
  account, different Claude conversations). Before pushing to `main`,
  `git fetch origin main` and check for commits you don't recognize —
  reconcile rather than force-overwrite.
