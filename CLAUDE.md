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
  gasoline.html          Gasoline — Fix Cash Advance app
  claim_manager.html      Cash Advance / Claim Manager app
  warranty.html            Export / Warranty Order Form app
```

`build.py` reads each `apps/*.html`, escapes `</script>` as `<\/script>`
(the launcher's `unesc()` reverses this at runtime), and substitutes it into
the matching placeholder in `index.template.html` to produce `index.html`.

## Update workflow

When the user says "update gasoline" / "update claim" / "update warranty" /
"update ทั้งหมด" / similar phrasing, with a new file attached (or already
pushed into `apps/`):

1. Replace the relevant `apps/<name>.html` with the new version.
2. Run `python3 build.py` to regenerate `index.html`.
3. Verify: `git diff --stat` should only touch `index.html` and the changed
   `apps/*.html` file — nothing else.
4. Commit and push to `main` (this repo's deployed branch — GitHub Pages
   serves directly from `main` root, no build step on GitHub's side).

Do not hand-edit `index.html` directly — always go through `apps/*.html` +
`build.py` so the two stay in sync.

## Notes

- No separate `warranty-app` repo dependency anymore — everything lives here.
- `main` branch history includes an old unrelated root (the former
  standalone warranty-app mirror) preserved via a merge commit — this is
  expected, not a mistake.
