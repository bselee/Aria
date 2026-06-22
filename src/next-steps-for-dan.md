# Next Steps for Dan — Dash Artwork Cleanup

## Priority 1: Fix CRAFT4 (blocking ordering)

CRAFT4 labels keep shipping with wrong barcodes because there is no CRAFT4 art file in Dash at all. The folder named "Craft4" actually holds the 44lb file.

**Step 1:** Rename folder `Craft4 - Label - 44 lb` → `Craft44 - Label - 44 lb`
**Step 2:** Create new folder `CRAFT4 - Label - 4lb`
**Step 3:** Upload correct CRAFT4 print-ready art into that folder
**Step 4:** Name the file `CRAFT4_Craft_Blend_4lb_8.5x11_PrintReady.pdf`

## Priority 2: Fix PU105L (Pumice Quart label)

Current art in Dash is for 1 Cu Ft, not Quart.

**Step 1:** Create folder `PU105L - Label - 1 Quart`
**Step 2:** Upload correct Pumice Quart label art
**Step 3:** Name the file `PU105L_Pumice_Quart_4x4_PrintReady.pdf`
**Step 4:** Delete or archive the wrong file `PU105_1 Cu Ft_Artwork1.png` from the PU114 folder

## Priority 3: Rename BAF02 file to add PrintReady tag

BAF02's art exists but automation can't confirm it.

**Step 1:** Rename `BAF02_CuFt_8.5x11.png` → `BAF02_BAF_3.0_CuFt_8.5x11_PrintReady.png`

## Priority 4: Add PrintReady tags to CWP artwork

These are correct art files but lack the PrintReady flag in the filename.

**Step 1:** `CWP01_Half lb_Artwork1.png` → `CWP01_CWP_Half_lb_PrintReady.png`
**Step 2:** `CWP02_1 lb_Artwork1.png` → `CWP02_CWP_1lb_PrintReady.png`
**Step 3:** `CWP03_2lb_Artwork1.png` → `CWP03_CWP_2lb_PrintReady.png`

## Priority 5: Upload remaining missing artwork

| Folder to Create | File Name |
|---|---|
| `WP101 - Label - 2 Gallon` | `WP101_Worm_Castings_2gal_5x6_PrintReady.pdf` |
| `BBL101 - Label` | `BBL101_BuildASoil_Big_Label_7.5x10_PrintReady.pdf` |
| `BAF1G - Label - 1 Gallon` | `BAF1G_BAF_1gal_PrintReady.pdf` |
| `GA105 - Label - 4 Ounce` | `GA105_GA_Label_PrintReady.pdf` |
| `OAG104 - Label - FCB Castor Bean 1gal` | `OAG104_FCB_Castor_Bean_1gal_Front_PrintReady.pdf` + Back |
| `OAG207 - Label - V-N 25lb` | `OAG207_V-N_25lb_PrintReady.pdf` |
| `OAG211 - Label - V-TR 25lb` | `OAG211_V-TR_25lb_PrintReady.pdf` |
| `GBB08 - Label` | `GBB08_Gnar_Bud_Butter_v8_PrintReady.pdf` |
| `GBB07 - Label` | `GBB07_Gnar_Bud_Butter_v7_PrintReady.pdf` |

---

# Barcode Data Check

Once artwork exists in Dash, we need to verify the barcode on the art matches what Finale expects for that SKU. This is the only way to catch a "CRAFT4 label with CRAFT10 barcode" before it prints.

## How It Would Work

1. Download the print-ready PDF from Dash
2. Read the barcode number from the PDF (same tech used to scan invoices)
3. Look up what barcode Finale has for that SKU
4. Compare — if they don't match, flag it before the order goes out

## What's Needed

**From IT/Dev:**
- Wire the existing barcode reader (used for AP invoice scanning) into the Dash download flow
- Create a check that runs: "For SKU CRAFT4, the barcode on the Dash art should match Finale's CRAFT4 barcode"
- Surface the result: ✓ match or ✗ mismatch

**From Dan:**
- Once art is uploaded with correct barcode, note the expected barcode number so it can be verified going forward

## The Data

We already have one barcode from today's scan of the PU104 label:

| Label | Barcode | SKU Match? |
|---|---|---|
| PU104 - 7 qt Pumice | 8 10168 42151 5 | Need to check against Finale PU104 |

Each print-ready label PDF in Dash can be checked the same way — read the barcode from the art file, compare against Finale.
