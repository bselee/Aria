# Dash Filename Cleanup — Actionable List

Only files that affect purchasing correlation are listed. Certs, marketing, fonts, and misc files are excluded.

## How to Rename in Dash

In Dash, open each file's details → rename the asset. The file itself doesn't change — just the display name. This takes ~2 min per file, ~30 min total.

## Batch 1: 9002 Prefix (7 files — highest priority)

These have a `9002-` vendor prefix that hides the real SKU. The parser extracts `9002` instead of `CRAFT10`, `BAV103`, etc.

| Current Name | Rename To |
|---|---|
| `9002-Craft10-11inW x 15.375inHx 4.75_D -PrintReady_10222025.pdf` | `CRAFT10_Craft_Blend_10lb_11x15.375_PrintReady_10222025.pdf` |
| `9002-Craft1_7.25x11x3.5in_Print Ready_10222025.pdf` | `CRAFT1_Craft_Blend_1lb_7.25x11x3.5_PrintReady_10222025.pdf` |
| `9002-BAV103_1 lb_6.125x9.5x3.5_PrintReady_10222025.pdf` | `BAV103_BuildAVeg_1lb_6.125x9.5x3.5_PrintReady_10222025.pdf` |
| `9002-BAV102_5 lb_11.5x15.375x4.75_PrintReady_10222025.pdf` | `BAV102_BuildAVeg_5lb_11.5x15.375x4.75_PrintReady_10222025.pdf` |
| `9002-BASTM6-104_kilo_7.25x11x3.5_PrintReady_10172025.pdf` | `BASTM6-104_Kilo_7.25x11x3.5_PrintReady_10172025.pdf` |
| `9002-BASTM6-103-300grams_6.125x9.5x3.5_PrintReady_10172025.pdf` | `BASTM6-103_300g_6.125x9.5x3.5_PrintReady_10172025.pdf` |
| `9002-BASTM6-102_100grams_4.75x6x2_PrintReady_10172025.pdf` | `BASTM6-102_100g_4.75x6x2_PrintReady_10172025.pdf` |

## Batch 2: Spaces in Names (6 files — medium priority)

These have spaces instead of underscores, so the parser reads the wrong SKU.

| Current Name | Rename To |
|---|---|
| `Craft 44 lb - Label - Print ready.pdf` | `CRAFT44_Craft_Blend_44lb_11x15.375_PrintReady_06162026.pdf` |
| `BAS Light_PrintReady_8.5x11.pdf` | `BASLIGHT101_Light_Recipe_8.5x11_PrintReady.pdf` |
| `KGD104_2 lb__5x6 Print Ready.pdf` | `KGD104_KGD_2lb_5x6_PrintReady_10152025.pdf` |
| `KGD104_2 lb__5x6 Label_Print Ready.pdf` | `KGD104_KGD_2lb_5x6_PrintReady_07282025.pdf` |
| `BBV101_ 1lb_6.125_x9.5_x3.5__PrintReady.pdf` | `BBV101_BuildABloom_1lb_6.125x9.5x3.5_PrintReady.pdf` |
| `BBV102_ 9_x13.5_x4.75__PrintReady.pdf` | `BBV102_BuildABloom_9x13.5x4.75_PrintReady.pdf` |

## Batch 3: Missing PrintReady Tag (9 art files — medium priority)

These are correct print-ready art but the filename doesn't have `PrintReady` in it, so automation can't confirm them. Add the tag.

| Current Name | Rename To |
|---|---|
| `BAF02_CuFt_8.5x11.png` | `BAF02_BAF_3.0_CuFt_8.5x11_PrintReady.png` |
| `PU105_1 Cu Ft_Artwork1.png` | **DO NOT RENAME — THIS IS THE WRONG FILE** (1 cu ft, not quart). Needs replacement. |
| `DLS105_Label_1CuFt_ 8.5x11.pdf` | `DLS105_DLS_1CuFt_8.5x11_PrintReady.pdf` |
| `DLS105_Label_8.5x11.png` | `DLS105_DLS_8.5x11_PrintReady.png` |
| `AG112_1 Gallon_5x6_Potassium Silicate Powder_Printable.pdf` | `AG112_Potassium_Silicate_1gal_5x6_PrintReady.pdf` |
| `CWP01_Half lb_Artwork1.png` | `CWP01_CWP_Half_lb_PrintReady.png` |
| `CWP02_1 lb_Artwork1.png` | `CWP02_CWP_1lb_PrintReady.png` |
| `CWP03_2lb_Artwork1.png` | `CWP03_CWP_2lb_PrintReady.png` |
| `QUE104_8 oz_Front_5x6.png` | `QUE104_QUE_8oz_Front_5x6_PrintReady.png` |
| `QUE104_8 oz_Back_5x6.png` | `QUE104_QUE_8oz_Back_5x6_PrintReady.png` |

## Batch 4: Organics Alive AI files (8 files — low priority)

These are existing Organics Alive label files with cryptic E-prefix names that should match OAG SKUs.

| Current Name | Rename To |
|---|---|
| `E1113712-RollLabe-335-VN-25lbs---Front-X100-Front.pdf` | `OAG207_V-N_25lb_Front_PrintReady.pdf` |
| `E1113712-RollLabe-335-VN-25lbs---Back-X100-Front.pdf` | `OAG207_V-N_25lb_Back_PrintReady.pdf` |
| `VTR 25 front.ai` | `OAG211_V-TR_25lb_Front_PrintReady.ai` |
| `VTR 25 back.ai` | `OAG211_V-TR_25lb_Back_PrintReady.ai` |
| `VPk 25 front.ai` | `OAG206_V-PK_25lb_Front_PrintReady.ai` |
| `VPK 25 back.ai` | `OAG206_V-PK_25lb_Back_PrintReady.ai` |
| `v cal gallon.ai` | `OAG110_VCal_1gal_Front_PrintReady.ai` |
| `v cal pint (1).ai` | `OAG109_VCal_1pint_Front_PrintReady.ai` |

## New Uploads Needed (critical for ordering)

These SKUs have **zero artwork in Dash**. They cannot be correlated until uploaded.

| Priority | SKU | Product | Needed File Name |
|---|---|---|---|
| **HIGH** | CRAFT4 | Craft Blend 4lb | `CRAFT4_Craft_Blend_4lb_8.5x11_PrintReady.pdf` |
| Medium | PU105L | Pumice Quart label | `PU105L_Pumice_Quart_4x4_PrintReady.pdf` (replaces wrong PU105 file) |
| Medium | WP101 | Worm Castings 2gal | `WP101_Worm_Castings_2gal_5x6_PrintReady.pdf` |
| Medium | GA105 | GA product label | `GA105_GA_Label_PrintReady.pdf` |
| Medium | BAF1G | BAF 1gal label | `BAF1G_BAF_1gal_PrintReady.pdf` |
| Low | OAG104FRBK | FCB Castor Bean 1gal | `OAG104_FCB_Castor_Bean_1gal_Front_PrintReady.pdf` + Back |
| Low | GBB08 | Gnar Bud Butter v8 | `GBB08_Gnar_Bud_Butter_v8_PrintReady.pdf` |
| Low | BABL101 | BuildASoil Big-ish Label | `BABL101_Big_ish_Label_PrintReady.pdf` |
| Low | DOM101 | Domain product label | `DOM101_Domain_Label_PrintReady.pdf` |

## After Cleanup: Running the Correlation

```bash
npx tsx src/cli/verify-artwork.ts --build-index
```

The report will show exact matches for every renamed file because the SKU will be the first segment. No more `9002` confusion, no more spaces hiding the real SKU.
