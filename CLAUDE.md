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
  warranty.html            Export / Warranty Order Form app (mirrored from
                            the external warranty-app repo, see below —
                            do not treat this copy as the source of truth)
```

`build.py` reads each `apps/*.html`, escapes `</script>` as `<\/script>`
(the launcher's `unesc()` reverses this at runtime), and substitutes it into
the matching placeholder in `index.template.html` to produce `index.html`.

## Update workflow

**Gasoline / Claim Manager** — source of truth is `apps/gasoline.html` /
`apps/claim_manager.html` in this repo. When the user says "update
gasoline" / "update claim" with a new file attached:

1. Replace `apps/gasoline.html` or `apps/claim_manager.html` with the new
   version.
2. Run `python3 build.py` to regenerate `index.html`.
3. Verify: `git diff --stat` should only touch `index.html` and the changed
   `apps/*.html` file — nothing else.
4. Commit and push to `main`.

**Warranty** — source of truth is the separate repo
`https://github.com/sitthikraiwong123-lab/warranty-app.git` (file
`Warranty App.html` at its root). When the user says "update warranty":

1. `add_repo` (if not already added this session) + clone/fetch
   `sitthikraiwong123-lab/warranty-app`, `git reset --hard origin/main` the
   local clone to pick up the latest push.
2. Copy its `Warranty App.html` content into this repo's
   `apps/warranty.html` (overwrite).
3. Run `python3 build.py` to regenerate `index.html`.
4. Verify: `git diff --stat` should only touch `index.html` and
   `apps/warranty.html`.
5. Commit and push to `main`.

Do not edit `apps/warranty.html` directly from an uploaded chat attachment
unless the user explicitly says the warranty-app repo is unavailable —
always prefer pulling from the warranty-app repo so it stays the single
source of truth for that app.

"update ทั้งหมด" / "update all" — do all three of the above in one pass.

Do not hand-edit `index.html` directly — always go through `apps/*.html` +
`build.py` so the two stay in sync.

## Notes

- `main` branch history includes an old unrelated root (the former
  standalone warranty-app mirror) preserved via a merge commit — this is
  expected, not a mistake.
- The `warranty-app` repo's history has been force-pushed/rewritten before
  (its root commit hash has changed at least once) — always re-fetch rather
  than assuming a previously cloned copy is current.
