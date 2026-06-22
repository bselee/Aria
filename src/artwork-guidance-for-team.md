# Artwork Organization for Purchasing

## The Problem

When purchasing orders labels or bags from Axiom Print or our bag suppliers, we have no way to verify the correct artwork exists before placing the order. This has led to multiple reprints of wrong labels (Craft barcode errors, wrong Pumice size, missing bag weights).

## The Fix

Dash is already organized by product folders (e.g. "Craft10 - Printed Bag - 10 lb"). We just need:

1. **Every product that gets labels or bags has a folder in Dash**
2. **That folder contains the final print-ready file**
3. **The folder name clearly identifies what SKU it's for**

## What We Found

After scanning all 300+ assets in Dash, here's what's missing or wrong:

### Missing — No Artwork Exists

These SKUs have zero print-ready files in Dash. Cannot be ordered confidently until artwork is added.

| SKU | Product | Notes |
|---|---|---|
| CRAFT4 | Craft Blend 4lb | **No art exists. This is why the wrong barcode shipped twice.** |
| PU105L | Pumice Quart label | Current file is for 1 Cu Ft, not Quart. Needs correct art. |
| WP101 | Worm Castings 2gal | Has print-ready art but in wrong folder |
| OAG104 | FCB Castor Bean 1gal | Missing entirely |
| OAG207 | V-N 10-2-2 Veg 25lb | Missing entirely |
| OAG211 | V-TR 4-5-5 Trans 25lb | Missing entirely |
| BBL101 | BuildASoil Big Label | Art exists but in "Generic" folder, not its own |
| BAF1G | BAF 1gal label | Missing entirely |
| GA105 | GA product label | Missing entirely |
| GBB08 | Gnar Bud Butter v8 | Missing entirely |
| BABL101 | BuildASoil Big-ish Label | Missing entirely |

### Wrong Folder — File Exists But In Wrong Place

| File | Current Folder | Should Be In |
|---|---|---|
| PU105_1 Cu Ft_Artwork1.png | PU114 - Label - 1/2 Cu Ft | Its own folder (it's the wrong size anyway) |
| Craft 44 lb - Label - Print ready.pdf | Craft4 - Label - 44 lb | **Craft44 - Label - 44 lb** (folder is misnamed) |

### Needs PrintReady Tag

These files are likely correct final artwork but lack "PrintReady" in the filename. Our automated check can't confirm them.

| File | Probable SKU |
|---|---|
| BAF02_CuFt_8.5x11.png | BAF02 |
| DLS105_Label_1CuFt_ 8.5x11.pdf | DLS105 |
| CWP01_Half lb_Artwork1.png | CWP01 |
| CWP02_1 lb_Artwork1.png | CWP02 |
| CWP03_2lb_Artwork1.png | CWP03 |

## What's Needed From Dan

1. **Create CRAFT4 folder** in Dash and upload the correct print-ready label art
2. **Rename** `Craft4 - Label - 44 lb` folder to `Craft44 - Label - 44 lb` (it's holding the 44lb file, not the 4lb file)
3. **Upload** missing artwork for the SKUs listed above (start with CRAFT4 and PU105L)
4. **Add "PrintReady"** to filenames of the art PNGs listed above
5. **Fix the PU105L file** — current art is 1 Cu Ft, need Quart size

## What This Unlocks

Once Dash is cleaned up, purchasing can run a scan that checks every SKU against Dash and reports:

- ✓ Art exists and is print-ready → order confidently
- ✗ No art in Dash → don't order until Dan provides it

That's it — no CLI before every order, just a periodic check that tells us what we can and can't order.
