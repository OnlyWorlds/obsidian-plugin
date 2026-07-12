# OnlyWorlds Plugin 2.0 — Test Checklist

Branch: `rebuild-2.0` · Bundle: `main.js` (~228KB)

Work through these in order. Each section has a clear pass/fail. Report what works, what's off — I'll fix.

If your dev vault already has a v1 world (notes with `<span>` tags), **do not run migration on it yet** — there's a dedicated section below where we test migration on a small/throwaway world first.

---

   
 

--- 

---
 

---

## Section 9 — Mobile (optional, skip if no test device)

If you have an iOS/Android device with Obsidian installed:

- [ ] Copy the build to the device's vault `.obsidian/plugins/onlyworlds-builder/` folder.
- [ ] Confirm the plugin loads on mobile.
- [ ] Confirm the ribbon icon appears (mobile's primary status surface).
- [ ] Confirm the status bar does NOT appear (mobile has no status bar).
- [ ] Confirm the migration command shows the "disabled on mobile" warning if you open the modal.
- [ ] Confirm Save Element works (will need to invoke via command palette since no hotkey).
- [ ] Confirm auto-sync works while editing in foreground.

**Expected**: full functionality except status bar and migration.

--- 
 
--- 
---

**Reference**: full design doc at `C:\Users\Titus\Carrier\Orrery\product\tools\obsidian-plugin-redesign.md`. The release checklist there is the wider scope; this file is the practical test pass.
