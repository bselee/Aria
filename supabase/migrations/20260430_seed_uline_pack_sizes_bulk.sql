-- ULINE pack-size bulk seed (auto-generated from MyOrderHistory.xlsx)
-- Run: node _run_migration.js supabase/migrations/20260430_seed_uline_pack_sizes_bulk.sql
-- Generated: 2026-04-30T21:25:46.012Z
-- Source: MyOrderHistory.xlsx

-- 64 SKUs with pack size parsed from description.
-- Upsert (ON CONFLICT) so re-running is safe and existing seeds get refreshed.
INSERT INTO sku_pack_sizes (sku, units_per_pack, pack_unit, ea_unit_price, source, notes) VALUES
    ('S-4905', 25, 'bundle', 0.0795, 'uline_history', '24 x 14 x 6" Corrugated Boxes 25/bundle'),
    ('S-4122', 25, 'bundle', 0.0396, 'uline_history', '12 x 12 x 6" Corrugated Boxes 25/bundle'),
    ('S-4738', 20, 'bundle', 0.1145, 'uline_history', '24 x 14 x 10" Corrugated Boxes 20/bundle'),
    ('S-6645', 6, 'case', 21.1765, 'uline_history', 'Uline Jumbo Industrial Reinforced Kraft Tape - 3" x 900'' 6 rolls/case'),
    ('S-4092', 25, 'bundle', 0.0203, 'uline_history', '9 x 5 x 5" Corrugated Boxes 25/bundle'),
    ('S-4503', 20, 'bundle', 0.1115, 'uline_history', '24 x 14 x 8" Corrugated Boxes 20/bundle'),
    ('S-4125', 25, 'bundle', 0.0436, 'uline_history', '12 x 12 x 12" Corrugated Boxes 25/bundle'),
    ('S-4128', 25, 'bundle', 0.0260, 'uline_history', '12 x 6 x 6" Long Corrugated Boxes 25/bundle'),
    ('S-4796', 20, 'bundle', 0.0995, 'uline_history', '22 x 14 x 6" Corrugated Boxes 20/bundle'),
    ('S-4181', 25, 'bundle', 0.0628, 'uline_history', '18 x 12 x 12" Corrugated Boxes 25/bundle'),
    ('S-3193', 25, 'bundle', 0.0816, 'uline_history', '40 x 48" 200 lb Corrugated Pads 25/bundle'),
    ('S-4551', 15, 'bundle', 0.2220, 'uline_history', '30 x 15 x 15" Corrugated Boxes 15/bundle'),
    ('S-4412', 15, 'bundle', 0.1980, 'uline_history', '15 x 15 x 30" Corrugated Boxes 15/bundle'),
    ('S-4124', 25, 'bundle', 0.0419, 'uline_history', '12 x 12 x 8" Corrugated Boxes 25/bundle'),
    ('S-4126', 25, 'bundle', 0.0476, 'uline_history', '12 x 12 x 10" Corrugated Boxes 25/bundle'),
    ('S-15045', 15, 'bundle', 0.2827, 'uline_history', '18 x 18 x 30" Corrugated Boxes 15/bundle'),
    ('S-12610', 10, 'bundle', 0.4100, 'uline_history', '24 x 13 x 31" Multi-Depth Corrugated Suitcase Boxes 10/bundle'),
    ('S-1667', 500, 'carton', 0.3280, 'uline_history', '12 x 15" 6 Mil Reclosable Bags 500/carton'),
    ('S-13505B', 120, 'case', 0.0104, 'uline_history', 'F-Style Jugs Bulk Pack - 32 oz, White 120/case'),
    ('S-1665', 500, 'carton', 0.2060, 'uline_history', '9 x 12" 6 Mil Reclosable Bags 500/carton'),
    ('S-14289', 15, 'bundle', 0.2367, 'uline_history', '22 x 22 x 14" Corrugated Boxes 15/bundle'),
    ('S-15625', 24, 'case', 0.3958, 'uline_history', 'Industrial Security Tape - "If Seal is Broken", 3" x 110 yds 24   rolls/case'),
    ('S-3902', 5000, 'pail', 0.0374, 'uline_history', 'Silica Gel Desiccants - Gram Size 1, 5 Gallon Pail 5,000 bags/pail'),
    ('S-13506B', 60, 'case', 0.0250, 'uline_history', 'F-Style Jugs Bulk Pack - 1/2 Gallon, White 60/case'),
    ('S-12849', 6, 'case', 7.6667, 'uline_history', 'Uline Kraft Paper Roll Towels - 8" x 800'' 6/case'),
    ('S-4654', 15, 'bundle', 0.1787, 'uline_history', '24 x 14 x 14" Corrugated Boxes 15/bundle'),
    ('S-445', 24, 'case', 0.1312, 'uline_history', 'Uline Industrial Tape - 2 Mil, 3" x 110 yds, Clear 24 rolls/case'),
    ('S-18374', 25, 'bundle', 0.0840, 'uline_history', '28 x 10 x 10" Long Corrugated Boxes 25/bundle'),
    ('S-15837B', 240, 'case', 0.0038, 'uline_history', 'F-Style Jugs Bulk Pack - 1 Pint, White 240/case'),
    ('S-10748B', 60, 'case', 0.0275, 'uline_history', 'F-Style Jugs Bulk Pack - 1 Gallon, White 60/case'),
    ('S-5050R', 100, 'box', 0.3600, 'uline_history', 'Uline Laser Labels - Fluorescent Red, 8 1/2 x 11" 100/box'),
    ('S-6019', 4, 'case', 6.0000, 'uline_history', 'Uline Handwrap - Cast, 80 gauge, 18" x 1,500'', White Opaque 4   rolls/case'),
    ('S-15122', 200, 'carton', 0.6300, 'uline_history', '24 x 42" 3 Mil Industrial Poly Bags 200/carton'),
    ('S-6490', 250, 'carton', 0.4760, 'uline_history', '24 x 36" 3 Mil Industrial Poly Bags 250/carton'),
    ('S-7178W', 16, 'case', 0.8750, 'uline_history', 'Uline Industrial Duct Tape - 3" x 60 yds, White 16 rolls/case'),
    ('S-11196', 1000, 'carton', 0.0780, 'uline_history', 'Super Stick Packing List Envelopes - 5 1/2 x 10" 1,000/carton'),
    ('S-4504', 20, 'bundle', 0.1135, 'uline_history', '24 x 16 x 6" Corrugated Boxes 20/bundle'),
    ('S-20543', 10, 'bundle', 0.4940, 'uline_history', '28 x 28 x 8" Corrugated Boxes 10/bundle'),
    ('S-5050Y', 100, 'box', 0.3600, 'uline_history', 'Uline Laser Labels - Fluorescent Yellow, 8 1/2 x 11" 100/box'),
    ('S-5111', 100, 'carton', 0.5800, 'uline_history', 'Uline Industrial Trash Liners - 44-55 Gallon, 1.5 Mil, Black   100/carton'),
    ('S-22481', 20000, 'carton', 0.0056, 'uline_history', 'Uline Stick Staples - C34 3/4" 20,000/carton'),
    ('S-13711', 440, 'box', 0.3614, 'uline_history', 'Premium White T-Shirt Rags - 50 lb box 440/box'),
    ('S-5105', 250, 'carton', 0.3520, 'uline_history', 'Uline Industrial Trash Liners - 33 Gallon, 1.5 Mil, Black 250/carton'),
    ('S-5050G', 100, 'box', 0.3600, 'uline_history', 'Uline Laser Labels - Fluorescent Green, 8 1/2 x 11" 100/box'),
    ('S-9927', 36, 'case', 0.1694, 'uline_history', 'Industrial Security Tape - "If Seal is Broken", 2" x 110 yds 36   rolls/case'),
    ('S-2835', 1000, 'carton', 0.0410, 'uline_history', '7 x 8" 2 Mil Reclosable Bags - 1 Quart 1,000/carton'),
    ('S-3166', 500, 'carton', 0.1900, 'uline_history', '16 x 16" 4 Mil Industrial Poly Bags 500/carton'),
    ('S-1748', 250, 'carton', 0.3720, 'uline_history', '24 x 42" 2 Mil Industrial Poly Bags 250/carton'),
    ('S-12229', 1000, 'carton', 0.0150, 'uline_history', 'Shrink Bands - 66mm x 28mm, Perforated 1,000/carton'),
    ('S-13264', 1000, 'carton', 0.1060, 'uline_history', 'Reclosable Polypropylene Bags - 2 Mil, 12 x 12" 1,000/carton'),
    ('S-7220RPW', 1000, 'carton', 0.0920, 'uline_history', 'Repair Tags - #5, Pre-wired, Red 1,000/carton'),
    ('H-541', 100, 'pack', 0.3000, 'uline_history', 'Uline Metal Truck Seals - Silver 100/Pack'),
    ('S-22361', 50, 'bundle', 1.5000, 'uline_history', 'Pallet Cones - Red 50/bundle'),
    ('S-18730', 165, 'box', 0.4545, 'uline_history', 'Standard White T-Shirt Rags - 25 lb box 165/box'),
    ('S-19883L', 12, 'carton', 5.0000, 'uline_history', 'Showa Atlas 451 Thermal Latex Coated Gloves - Large 12   pairs/carton'),
    ('S-19883X', 12, 'carton', 5.0000, 'uline_history', 'Showa Atlas 451 Thermal Latex Coated Gloves - XL 12   pairs/carton'),
    ('S-14824', 12, 'case', 4.8333, 'uline_history', 'Uline Air Freshener Spray - Citrus Blossom 12 cans/case'),
    ('S-4381', 25, 'bundle', 0.0908, 'uline_history', '6 x 6 x 48" Tall Corrugated Boxes 25/bundle'),
    ('S-24314', 25, 'carton', 1.8000, 'uline_history', '3M PA1 - G Hand Applicator 25/carton'),
    ('S-12230', 1000, 'carton', 0.0150, 'uline_history', 'Shrink Bands - 75mm x 28mm, Perforated 1,000/carton'),
    ('S-14783', 100, 'box', 0.2200, 'uline_history', 'Name Badge Holders - 2 x 3", Vertical, Pre-Punched 100/box'),
    ('S-16183', 200, 'box', 0.0175, 'uline_history', '70% Isopropyl Prep Pads 200/box'),
    ('S-14138', 5000, 'carton', 0.0006, 'uline_history', 'Desktop Staples - 1/4" 5,000/carton'),
    ('S-4902', 25, 'bundle', 0.0000, 'uline_history', '20 x 16 x 6" Corrugated Boxes 25/bundle')
ON CONFLICT (sku) DO UPDATE SET
    units_per_pack = EXCLUDED.units_per_pack,
    pack_unit      = EXCLUDED.pack_unit,
    ea_unit_price  = EXCLUDED.ea_unit_price,
    source         = EXCLUDED.source,
    notes          = EXCLUDED.notes,
    updated_at     = NOW();

-- 93 SKUs with NO parseable pack size — fill in manually if needed
-- Most likely 1/each (uline lists eaches by default for many items)
-- Format: ('SKU', UNITS, 'UNIT', EA_PRICE_NULL_OR_NUM, 'uline_manual', 'NOTE')
-- S-19740    avg $417.86/unit  desc="Instant Bubble Film - Large, 12" x 1,250''"
-- H-7127     avg $3750.00/unit  desc="Portacool Jetstream Evaporative Cooler - 36""
-- H-754      avg $1650.00/unit  desc="Low Profile Floor Scale - 4 x 4'', 5,000 lbs x 1 lb"
-- S-20046    avg $6.10/unit  desc="EZ-Pour F-Style Jugs - 2 1/2 Gallon"
-- H-6754     avg $1095.00/unit  desc="Uline Manual Lift Table - Standard, 63 x 31 1/2", 1,100 lb"
-- S-12527    avg $20.78/unit  desc="3M 6006 Multiple Toxic Gases Cartridge 2/package"
-- S-17888    avg $30.80/unit  desc="Giant Plastic Stackable Bins - 17 1/2 x 16 1/2 x 12 1/2", Clear"
-- H-384BL    avg $4.82/unit  desc="Sharpie Magnum Markers - Black"
-- S-11443    avg $16.00/unit  desc=""Fragile Liquid/Handle With Care" Labels - 2 x 3" 500/roll"
-- H-1719BL   avg $116.33/unit  desc="Anti-Fatigue Mat - 5/8" thick, 3 x 8'', Black"
-- H-2646G    avg $325.00/unit  desc="Shelf Bin Organizer - 36 x 18 x 39" with 11 x 18 x 4" Green Bins"
-- H-1028     avg $318.00/unit  desc="Uline Pneumatic Stick Stapler "C" - 3/4""
-- H-7130     avg $120.00/unit  desc="Replacement Pad for Portacool Jetstream 260 Evaporative   Cooler"
-- S-14819    avg $66.00/unit  desc="Uline Industrial Wipers - Dispenser Box 90 wipes/box"
-- S-9752     avg $64.89/unit  desc="3M 501 Prefilter Retainer for Respirators 20/package"
-- S-9749     avg $24.45/unit  desc="3M 5N11 N95 Prefilter 10/package"
-- H-7893     avg $255.00/unit  desc="Little Giant Folding Step Ladder - 4 Steps"
-- S-7541P    avg $63.00/unit  desc="Heavy Duty Bubble Roll - 12" x 250'', 1/2", Perforated 4 rolls/bundle"
-- H-384R     avg $4.84/unit  desc="Sharpie Magnum Markers - Red"
-- H-4053BL   avg $460.00/unit  desc="Collapsible Bulk Container - 48 x 45 x 42", 1,500 lb Capacity, Black"
-- H-7287     avg $414.00/unit  desc="Edge Seal Wire Assembly for NewAir I.B. Flex Machine"
-- H-7831BL   avg $395.00/unit  desc="Collapsible Bulk Container - 48 x 45 x 34", 1,500 lb Capacity, Black"
-- H-4987     avg $30.45/unit  desc="3M 6503 Half-Face Respirator - Large"
-- H-7841     avg $300.00/unit  desc="Reel Rack - 36 x 24 x 84""
-- H-204      avg $48.00/unit  desc="24" Service Kit for H-86 Foot-Operated Impulse Sealer"
-- H-1211     avg $135.00/unit  desc="Rackable Plastic Pallet - 48 x 40", Black"
-- H-754-LP7510 avg $260.00/unit  desc="LP7510A Display Indicator Kit for Standard Low Profile Floor Scales"
-- H-754-7510CB avg $47.00/unit  desc="Cable for Standard Low Profile Scales"
-- H-4114     avg $235.00/unit  desc="Deluxe Mesh Task Chair"
-- S-2255     avg $235.00/unit  desc="Steel Strapping - High Tensile, 5/8" x .023" x 2,152''"
-- H-8661     avg $115.00/unit  desc="Vinyl Cover for Portacool Evaporative Cooler - 36" Fan"
-- H-5490     avg $110.00/unit  desc="Solid Top Rackable Pallet - 48 x 40", 1,600 lb Capacity, Black"
-- H-4986     avg $31.00/unit  desc="3M 6502 Half-Face Respirator - Medium"
-- H-11206    avg $190.00/unit  desc="Uline Work Chair"
-- H-2755BL   avg $7.75/unit  desc="Uline Folding Knife - Black"
-- S-18260    avg $1.18/unit  desc="Square Tubes - 2 x 2 x 37", White"
-- H-7286     avg $174.00/unit  desc="ROLLER ASSEMBLY FOR H-7259"
-- S-23380G   avg $75.00/unit  desc="Privacy Screen - 68" x 50'', Green"
-- S-17132    avg $18.50/unit  desc="Uline Tuff Scrub Hand Soap Gallon - Pumice"
-- S-19184    avg $36.00/unit  desc="3M 60921 Organic Vapor Cartridge/Filter Combo P100 2/package"
-- H-6469     avg $67.00/unit  desc="Uline ANSI Approved First Aid Kit - Class A, 25 Person"
-- H-8157     avg $21.67/unit  desc="Job Site Fan"
-- H-11036    avg $65.00/unit  desc="Uline Contractor''s First Aid Kit"
-- H-3831     avg $41.00/unit  desc="Contractors Broom - 36", Medium Bristles"
-- H-1259     avg $60.00/unit  desc="24" Service Kit for H-1257 Foot-Operated Impulse Sealer with Cutter"
-- S-11444    avg $23.00/unit  desc=""Fragile Liquid/Handle With Care" Labels - 3 x 5" 500/roll"
-- H-7259-PAD avg $114.00/unit  desc="NEW AIR FLEX MEMBRANE PAD"
-- S-14454C   avg $18.10/unit  desc="Plastic Stackable Bins - 18 x 8 x 9", Clear"
-- H-3328BL-S avg $51.00/unit  desc="Pneumatic Caster - Swivel, 8 x 2 1/2", Black"
-- H-4196     avg $50.00/unit  desc="Aircraft Wheel Chocks - 10 x 5 x 4 1/2""
-- ...and 43 more (showing top 50 by spend)
