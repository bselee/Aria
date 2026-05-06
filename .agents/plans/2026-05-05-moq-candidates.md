# MOQ Candidate Survey — 2026-05-05

**Window:** last 365 days · **Vendors with PO activity:** 145 · **MOQ-language emails found:** 36

## How to read this

- **Default state = no MOQ.** Most vendors don't have one; the table reflects that.
- "Most recent PO" = the current price/qty pattern Will sees with this vendor.
- "Email evidence" lists messages containing MOQ rejection language. Only these warrant seeding `vendor_minimum_orders`.
- Per-SKU **STD Packing** (Finale "Std reorder in qty of") is already used by the recommender for pack rounding — not surfaced here per vendor.

## Vendors with email evidence (review priority)

| Vendor | POs | Most Recent | Recent Total | Hits | Suggested action |
|---|---|---|---|---|---|
| **Grove Bags (Kinzie Advanced Polymers))** | 5 | 7/9/2025 (2 lines) | $1,319.60 | 3 | seed MOQ — see evidence below |
| **Rapid Packaging** | 3 | 4/30/2026 (1 lines) | $4,801.12 | 1 | seed MOQ — see evidence below |
| **Ecostadt Technologies LLC** | 1 | 2/27/2026 (1 lines) | $1,954.29 | 7 | seed MOQ — see evidence below |

### Evidence detail

#### Grove Bags (Kinzie Advanced Polymers))

- Most recent PO: 7/9/2025 — $1,319.60 (2 lines)
- All POs in window: 5 · median $859.55 · range $333.16–$1,319.60
- vendor_party_id: `10882`

  - **minimum order quantity** · default@ · Kate Dolan <kated@unitedbags.com> · Thu, 11 Dec 2025
    - Subj: RE: [CAUTION: SUSPECT SENDER] BuildASoil PO # 124220 - Sun Coast Packaging, Inc. - 12/10/2025
    - "Received, thanks again, Bill! The order is scheduled for pickup today and estimated to arrive on Tuesday via FedEx Freight Pro# 886974618892. Kate Dolan Account Executive United Bags, Inc. O: 314-455-"
  - **minimum order quantity** · default@ · Kate Dolan <kated@unitedbags.com> · Wed, 10 Dec 2025
    - Subj: RE: [CAUTION: SUSPECT SENDER] BuildASoil PO # 124220 - Sun Coast Packaging, Inc. - 12/10/2025
    - "Perfect, thanks, Bill! Do you have a tax exempt form for the business? Our accounting team requires these on file now to withhold the tax on your invoices. Kate Dolan Account Executive United Bags, In"
  - **minimum order quantity** · default@ · Kate Dolan <kated@unitedbags.com> · Wed, 10 Dec 2025
    - Subj: RE: [CAUTION: SUSPECT SENDER] BuildASoil PO # 124220  -  Sun Coast Packaging, Inc.  -  12/10/2025
    - "Hi Bill, These can ship out tomorrow but it doesn&#39;t hit the minimum order quantity. Would you like 2000 bags instead of 1000 or is there anything else that can be added? Kate Dolan Account"

#### Rapid Packaging

- Most recent PO: 4/30/2026 — $4,801.12 (1 lines)
- All POs in window: 3 · median $4,801.12 · range $1,776.00–$6,097.32
- vendor_party_id: `10925`

  - **minimum order quantity** · default@ · Jeremy Oberg <jeremy.oberg@rapidpackaging.com> · Wed, 2 Jul 2025 
    - Subj: Price Reduction Alert!
    - "Hi Bill, For a limited time, we&#39;ve just lowered the price of 8” x 4” and 8” x 6” machine air pillows – now only $65/roll - a 35% savings! Click to Shop or Buy Now: 8” x 6” x 1575&#39; - https://"

#### Ecostadt Technologies LLC

- Most recent PO: 2/27/2026 — $1,954.29 (1 lines)
- All POs in window: 1 · median $1,954.29 · range $1,954.29–$1,954.29
- vendor_party_id: `10029`

  - **minimum order quantity** · ap@ · Lakshmi <lakshmi@ecostadt.com> · Fri, 6 Mar 2026 
    - Subj: BuildASoil Invoice, PL for PO 124418
    - "Hi There, Please find attached Invoice, Packing List and Delivery Receipt for PO 124418. This was delivered on March 5 th at Montrose, CO. Thank You Lakshmi From: Bill Selee &lt;bill.selee@buildasoil."
  - **minimum order quantity** · default@ · Lakshmi <lakshmi@ecostadt.com> · Fri, 6 Mar 2026 
    - Subj: BuildASoil Invoice, PL for PO 124418
    - "Hi There, Please find attached Invoice, Packing List and Delivery Receipt for PO 124418. This was delivered on March 5 th at Montrose, CO. Thank You Lakshmi From: Bill Selee &lt;bill.selee@buildasoil."
  - **minimum order quantity** · default@ · Lakshmi <lakshmi@ecostadt.com> · Tue, 3 Mar 2026 
    - Subj: RE: Inquiry about Availability and Pricing for NEEM
    - "Thank You Bill. Lakshmi From: Bill Selee &lt;bill.selee@buildasoil.com&gt; Sent: Tuesday, March 3, 2026 11:17 AM To: Lakshmi &lt;lakshmi@ecostadt.com&gt; Cc: Senrayan Ramasamy &lt;senrayan@ecostadt.co"
  - **minimum order quantity** · default@ · Lakshmi <lakshmi@ecostadt.com> · Tue, 3 Mar 2026 
    - Subj: RE: Inquiry about Availability and Pricing for NEEM
    - "Hi Bill, Sorry, I want to let you know we shipped one pallet of ECOMAX with 40 Bags, we couldn&#39;t ship 50 Bags. We are shipping it in Pallet count. Carrier-ESTES Freight cost- $ 354.29 PRO # 212-"
  - **minimum order quantity** · default@ · Senrayan Ramasamy <senrayan@ecostadt.com> · Fri, 27 Feb 2026
    - Subj: Re: Inquiry about Availability and Pricing for NEEM
    - "Hi Bill, Will do. Thanks Sen EcoStadt Technologies LLC Sen Ramasamy Ph.D. | President senrayan@ecostadt.com | (916) 730-2806 EcoStadt Technologies LLC Office: (916) 357-6607 | Fax: (916) 357-6501 1024"

## All vendors — most recent PO snapshot

Sorted by PO count desc. **Default seed action = none.** Only seed when the vendor appears above with email evidence.

| Vendor | POs | Most Recent | Recent Total | Median | Range | party_id |
|---|---|---|---|---|---|---|
| Printful | 750 | 9/9/2025 (3L) | $43.87 | $20.63 | $4.75–$132.90 | `10080` |
| Autopot Watering Systems | 298 | 9/8/2025 (1L) | $146.98 | $84.00 | $39.74–$723.19 | `10757` |
| EverGreen Growers Supply | 122 | 9/8/2025 (2L) | $101.99 | $110.83 | $31.50–$433.58 | `10219` |
| Sustainable Village | 63 | 9/9/2025 (1L) | $348.30 | $348.30 | $49.00–$8,327.57 | `10809` |
| Axiom Print | 61 | 4/8/2026 (1L) | $574.43 | $446.35 | $37.48–$3,218.29 | `10917` |
| ULINE | 55 | 9/17/2025 (3L) | $807.09 | $2,315.48 | $51.06–$719,131.44 | `10083` |
| Grand Master LED | 47 | 9/2/2025 (1L) | $950.00 | $625.00 | $150.00–$1,875.00 | `10886` |
| Thirsty Earth | 42 | 9/4/2025 (1L) | $61.00 | $83.00 | $61.00–$318.50 | `10852` |
| Grassroots Fabric Pots | 40 | 9/29/2025 (1L) | $1,139.70 | $1,105.22 | $38.67–$5,729.20 | `10201` |
| Rootwise Soil Dynamics | 32 | 9/17/2025 (5L) | $29,572.63 | $10,228.81 | $388.40–$34,068.00 | `10066` |
| Miles Filippelli | 31 | 9/22/2025 (2L) | $4,776.00 | $2,453.00 | $24.00–$6,708.00 | `10340` |
| Eden Blue Gold / Eden Solutions LLC | 30 | 7/7/2025 (1L) | $32.11 | $35.53 | $18.00–$178.91 | `10555` |
| Rock Dust Local | 26 | 9/2/2025 (1L) | $63.50 | $60.25 | $49.60–$2,280.00 | `10321` |
| Amazon | 25 | 9/23/2025 (1L) | $280.62 | $299.85 | $28.99–$1,739.98 | `10154` |
| Lightning Labels | 21 | 9/5/2025 (1L) | $390.00 | $795.49 | $121.79–$2,336.76 | `10680` |
| Stock Bag Depot | 19 | 9/9/2025 (1L) | $520.00 | $1,260.00 | $257.00–$5,253.00 | `10070` |
| Colorado Worm Company | 19 | 9/2/2025 (1L) | $3,750.00 | $3,600.00 | $800.00–$10,000.00 | `10477` |
| Thrive Probiotics | 19 | 9/15/2025 (3L) | $4,200.00 | $1,497.50 | $750.00–$4,850.00 | `10740` |
|  | 17 | 9/30/2025 (0L) | $0.00 | $0.00 | $0.00–$0.00 | `—` |
| Gary Ambriol | 16 | 9/12/2025 (1L) | $11,400.00 | $11,400.00 | $375.00–$12,675.00 | `10666` |
| Coats Agri-Aloe | 15 | 9/5/2025 (1L) | $2,342.15 | $2,345.48 | $2,342.15–$7,590.00 | `10432` |
| Smith Pallets | 15 | 9/2/2025 (1L) | $1,620.00 | $1,620.00 | $1,530.00–$1,620.00 | `10415` |
| Farm Fuel Inc. | 13 | 9/24/2025 (1L) | $9,560.59 | $3,150.00 | $986.25–$1,171,864.60 | `10684` |
| Quinton O'Connor | 13 | 9/22/2025 (10L) | $1,840.50 | $1,011.50 | $105.00–$2,188.50 | `10903` |
| Malibu Compost | 13 | 8/6/2025 (1L) | $13,339.49 | $13,339.49 | $4,153.84–$14,249.04 | `10043` |
| JABB of the Carolinas, Inc. | 12 | 8/19/2025 (2L) | $1,779.10 | $1,664.49 | $760.00–$7,220.00 | `10453` |
| AC Infinity Inc. | 12 | 9/15/2025 (8L) | $10,011.14 | $1,023.72 | $107.21–$10,011.14 | `10565` |
| Organics Alive | 10 | 8/27/2025 (8L) | $50,495.20 | $12,523.64 | $500.00–$95,574.88 | `10566` |
| Berger | 10 | 9/10/2025 (1L) | $26,241.03 | $13,635.05 | $11,834.19–$33,958.98 | `10594` |
| Ferticell | 10 | 8/4/2025 (2L) | $6,131.72 | $6,866.99 | $3,875.20–$9,060.48 | `10518` |
| TeaLAB | 10 | 9/17/2025 (1L) | $380.00 | $480.00 | $100.00–$990.00 | `10074` |
| Aloe Corp | 10 | 7/30/2025 (1L) | $990.00 | $1,386.00 | $198.00–$1,980.00 | `10003` |
| TeraGanix | 9 | 7/7/2025 (1L) | $1,895.62 | $1,407.00 | $149.70–$627,838.72 | `10075` |
| Organishield | 9 | 9/3/2025 (1L) | $1,890.72 | $655.38 | $331.90–$1,890.72 | `10854` |
| CR Minerals Company, LLC | 9 | 9/29/2025 (2L) | $18,042.75 | $17,075.00 | $13,668.80–$19,450.00 | `10024` |
| Greenhouse Megastore | 8 | 9/15/2025 (1L) | $115.68 | $270.70 | $115.68–$356.40 | `10520` |
| Seacoast Compost | 8 | 9/2/2025 (2L) | $12,608.50 | $11,160.74 | $11.35–$14,812.08 | `10904` |
| GrowGeneration | 8 | 9/30/2025 (1L) | $2,430.04 | $1,914.12 | $126.00–$4,380.53 | `10835` |
| Marion Ag Service, Inc | 8 | 9/2/2025 (3L) | $8,204.50 | $8,313.25 | $860.71–$11,368.50 | `10421` |
| Novelty Manufacturing / Earthbox | 8 | 9/18/2025 (2L) | $2,016.01 | $2,013.78 | $512.24–$4,078.61 | `10028` |
| Concentrates Inc. | 8 | 9/10/2025 (5L) | $7,058.40 | $4,858.83 | $1,707.20–$7,142.42 | `10021` |
| Primary Packaging | 8 | 9/3/2025 (2L) | $12,404.56 | $11,422.50 | $8,175.00–$17,250.00 | `10902` |
| Organic AG Products | 7 | 8/13/2025 (2L) | $2,720.17 | $2,575.98 | $829.22–$5,660.86 | `10059` |
| Diamond K Gypsum | 7 | 7/14/2025 (3L) | $4,810.00 | $3,580.00 | $960.15–$5,710.77 | `10438` |
| Granite Mill Farms | 7 | 9/10/2025 (1L) | $12,120.00 | $11,680.00 | $2,318.40–$12,683.02 | `10888` |
| American Extracts | 7 | 8/22/2025 (2L) | $2,851.40 | $1,404.30 | $529.38–$2,851.40 | `10009` |
| Colorful Packaging Ltd | 6 | 4/30/2026 (11L) | $4,145.91 | $3,120.46 | $650.00–$9,514.56 | `10918` |
| HerbsNOW | 6 | 9/10/2025 (1L) | $1,920.00 | $1,920.00 | $1,080.00–$3,840.00 | `10897` |
| Left Coast Garden Wholesale | 6 | 8/5/2025 (1L) | $197.76 | $267.99 | $197.76–$1,062.99 | `10041` |
| Ferti-Organic | 6 | 5/7/2025 (1L) | $1,098.00 | $1,049.00 | $685.00–$1,224.00 | `10414` |
| New Moon Development Co | 6 | 9/16/2025 (1L) | $4,725.00 | $3,150.00 | $2,362.50–$7,087.50 | `10857` |
| Roastar | 6 | 9/10/2025 (1L) | $1,445.00 | $2,900.00 | $376.00–$3,456.00 | `10869` |
| Clarke | 5 | 5/1/2026 (1L) | $11,250.00 | $7,198.08 | $6,250.00–$11,250.00 | `10922` |
| International Molasses Corporation ltd. | 5 | 7/18/2025 (1L) | $1,967.39 | $1,967.39 | $1,056.00–$157,372.80 | `10039` |
| Biochar Solutions, llc | 5 | 7/30/2025 (1L) | $4,600.00 | $20,800.00 | $4,600.00–$23,920.00 | `10440` |
| Grove Bags (Kinzie Advanced Polymers)) | 5 | 7/9/2025 (2L) | $1,319.60 | $859.55 | $333.16–$1,319.60 | `10882` |
| Sun Coast Packaging, Inc. | 5 | 4/6/2026 (2L) | $2,378.68 | $1,028.06 | $860.00–$2,378.68 | `10358` |
| Faust Bio Agriculture | 5 | 8/19/2025 (1L) | $4,605.00 | $4,605.00 | $4,030.00–$5,510.00 | `10268` |
| Bee Rite | 5 | 7/30/2025 (1L) | $649.00 | $1,810.88 | $649.00–$3,360.21 | `10543` |
| PULSE USA | 4 | 9/19/2025 (1L) | $7,762.50 | $8,000.00 | $6,382.50–$8,237.50 | `10063` |
| Riceland USA | 4 | 5/20/2025 (1L) | $7,929.84 | $6,414.84 | $2,711.50–$9,621.59 | `10065` |
| C and S Plastics | 4 | 9/2/2025 (1L) | $864.00 | $1,129.41 | $864.00–$2,555.69 | `10651` |
| Chapin INC | 4 | 8/29/2025 (2L) | $4,752.20 | $2,408.79 | $91.32–$4,752.20 | `10019` |
| North Spore | 4 | 4/30/2026 (1L) | $251.25 | $280.46 | $251.25–$540.46 | `10921` |
| SafeSolutions | 4 | 7/11/2025 (1L) | $900.00 | $666.00 | $333.00–$978.21 | `10067` |
| HEMPIN | 4 | 9/24/2025 (1L) | $1,200.00 | $1,200.00 | $100.00–$1,200.00 | `10544` |
| Toker Poker | 4 | 6/20/2025 (1L) | $570.00 | $570.00 | $570.00–$2,770.00 | `10893` |
| Certis USA | 4 | 7/30/2025 (1L) | $9,840.00 | $5,431.73 | $2,535.00–$9,840.00 | `10138` |
| Cen-Tec Systems | 4 | 9/19/2025 (2L) | $515.60 | $446.32 | $301.50–$579.32 | `10898` |
| The Amazing Dr. Zymes | 4 | 8/19/2025 (1L) | $1,086.24 | $941.19 | $248.28–$1,086.24 | `10604` |
| Kevin Thorbahn | 4 | 8/6/2025 (1L) | $588.00 | $474.00 | $300.00–$600.00 | `10712` |
| Gro-Kashi International | 4 | 9/18/2025 (1L) | $4,240.25 | $4,131.61 | $3,325.21–$6,651.63 | `10038` |
| Country Malt - Mid Country | 4 | 8/22/2025 (1L) | $2,379.30 | $2,379.30 | $2,379.30–$2,489.97 | `10023` |
| Becker Microbial products, Inc | 4 | 9/19/2025 (1L) | $3,750.00 | $3,750.00 | $3,750.00–$3,998.12 | `10853` |
| A+ Label | 4 | 7/30/2025 (3L) | $2,741.05 | $2,044.90 | $1,227.91–$2,741.05 | `10636` |
| Cleverly Creative dba Growing Organic | 4 | 7/30/2025 (9L) | $4,856.00 | $3,113.00 | $1,200.00–$4,856.00 | `10470` |
| Material Motion | 4 | 7/29/2025 (1L) | $6,978.15 | $10,079.55 | $6,978.15–$11,630.25 | `10646` |
| Great Western Sales and Distribution, LLC | 3 | 5/28/2025 (2L) | $3,782.00 | $3,576.00 | $641.25–$3,782.00 | `10037` |
| Titan Biologics | 3 | 7/29/2025 (2L) | $1,584.00 | $864.00 | $378.00–$1,584.00 | `10246` |
| Rapid Packaging | 3 | 4/30/2026 (1L) | $4,801.12 | $4,801.12 | $1,776.00–$6,097.32 | `10925` |
| ROCKUTAH | 3 | 9/15/2025 (1L) | $4,360.02 | $4,334.01 | $4,308.00–$4,360.02 | `10773` |
| Arla Foods | 3 | 7/30/2025 (1L) | $9,560.00 | $4,784.03 | $382.40–$9,560.00 | `10841` |
| BFG Supply Co. | 3 | 7/30/2025 (1L) | $230.20 | $293.29 | $230.20–$1,972.86 | `10801` |
| North Mason Fiber Company | 3 | 5/27/2025 (1L) | $9,515.00 | $9,515.00 | $65.00–$10,015.00 | `10057` |
| MORR | 3 | 6/11/2025 (1L) | $2,520.00 | $2,520.00 | $554.40–$2,920.00 | `10830` |
| Funtechnik import | 3 | 4/30/2026 (1L) | $300.00 | $3,463.25 | $300.00–$3,630.31 | `10926` |
| Plantae Labs | 3 | 5/19/2025 (1L) | $45,147.71 | $33,987.91 | $3,025.00–$45,147.71 | `10836` |
| Lind Marine, INC | 3 | 9/10/2025 (1L) | $7,130.00 | $3,167.14 | $878.96–$7,130.00 | `10078` |
| Seaforth Minerals | 3 | 7/30/2025 (1L) | $4,056.90 | $4,056.90 | $3,000.00–$4,180.00 | `10851` |
| Thorvin | 3 | 6/11/2025 (1L) | $9,525.00 | $12,629.50 | $9,525.00–$12,725.98 | `10081` |
| The Rock Shop | 3 | 5/19/2025 (1L) | $1,081.99 | $1,226.20 | $1,081.99–$1,226.70 | `10077` |
| Horticulture Lighting Group | 3 | 12/15/2025 (1L) | $380.54 | $359.00 | $326.69–$380.54 | `10761` |
| FZone | 3 | 8/22/2025 (1L) | $2,092.56 | $2,092.56 | $2,092.56–$2,092.56 | `10913` |
| niwa Grow hub | 3 | 6/2/2025 (1L) | $92.88 | $92.88 | $92.88–$92.88 | `10611` |
| Aether Green | 3 | 5/5/2025 (3L) | $995.00 | $995.00 | $167.69–$995.00 | `10883` |
| Trim-Lok | 2 | 5/5/2025 (1L) | $610.29 | $320.65 | $31.00–$610.29 | `10831` |
| Lexar Industrial | 2 | 4/30/2026 (1L) | $31.89 | $30.44 | $28.99–$31.89 | `10861` |
| Americord | 2 | 4/30/2026 (1L) | $177.00 | $622.43 | $177.00–$1,067.86 | `10889` |
| Cornerstone Protein/Uptake Farms Inc | 2 | 9/2/2025 (1L) | $14,550.00 | $8,768.75 | $2,987.50–$14,550.00 | `10840` |
| Hortitech Direct / CannaBrush | 2 | 4/30/2026 (1L) | $110.00 | $217.50 | $110.00–$324.99 | `10574` |
| Liberty Natural Products Inc. | 2 | 4/30/2026 (1L) | $119.04 | $238.08 | $119.04–$357.12 | `10042` |
| Hydrofarm | 2 | 4/30/2026 (1L) | $143.78 | $698.69 | $143.78–$1,253.60 | `10563` |
| Lightray | 2 | 4/30/2026 (1L) | $114.93 | $4,554.10 | $114.93–$8,993.26 | `10868` |
| Al and Jerry’s llc | 2 | 4/30/2026 (1L) | $0.00 | $8,705.00 | $8,705.00–$8,705.00 | `10928` |
| BuildASoil Manufacturing | 2 | 7/30/2025 (3L) | $0.00 | $0.00 | $0.00–$0.00 | `10086` |
| Covico | 2 | 5/7/2025 (1L) | $50,548.68 | $50,411.34 | $50,274.00–$50,548.68 | `10745` |
| Walmart | 2 | 2/11/2026 (1L) | $135.00 | $159.21 | $135.00–$183.42 | `10372` |
| Go Big Banners | 2 | 1/23/2026 (0L) | $0.00 | $1,598.57 | $1,598.57–$1,598.57 | `10354` |
| BCU Plastics | 2 | 12/29/2025 (1L) | $318.00 | $221.95 | $125.90–$318.00 | `10927` |
| Dominion Seed Co | 2 | 7/31/2025 (3L) | $336.00 | $850.00 | $336.00–$1,364.00 | `10911` |
| Acadian Supply | 2 | 7/17/2025 (1L) | $0.00 | $1,207.00 | $1,207.00–$1,207.00 | `10901` |
| Highgrove Lighting | 2 | 7/9/2025 (2L) | $11,450.00 | $8,750.00 | $6,050.00–$11,450.00 | `10752` |
| Organics Alive | 1 | 4/30/2026 (2L) | $1,960.00 | $1,960.00 | $1,960.00–$1,960.00 | `10814` |
| Raoping Xingcheng | 1 | 4/30/2026 (2L) | $394.69 | $394.69 | $394.69–$394.69 | `10862` |
| Dicalite | 1 | 4/30/2026 (1L) | $153.00 | $153.00 | $153.00–$153.00 | `10877` |
| Michael Fury | 1 | 4/30/2026 (1L) | $750.00 | $750.00 | $750.00–$750.00 | `10707` |
| Bulk Apothecary | 1 | 4/30/2026 (1L) | $45.08 | $45.08 | $45.08–$45.08 | `10820` |
| Window Peak Trace Minerals | 1 | 4/30/2026 (1L) | $0.00 | $0.00 | $0.00–$0.00 | `10262` |
| Himalayan Distribution llc | 1 | 4/30/2026 (1L) | $22.00 | $22.00 | $22.00–$22.00 | `10839` |
| AFT Fasteners | 1 | 4/30/2026 (1L) | $15.11 | $15.11 | $15.11–$15.11 | `10892` |
| Mammoth Lighting | 1 | 4/30/2026 (1L) | $0.00 | $0.00 | $0.00–$0.00 | `10932` |
| Surepack USA | 1 | 4/8/2026 (3L) | $3,467.00 | $3,467.00 | $3,467.00–$3,467.00 | `10934` |
| Hanin | 1 | 3/5/2026 (1L) | $215.97 | $215.97 | $215.97–$215.97 | `10933` |
| Ecostadt Technologies LLC | 1 | 2/27/2026 (1L) | $1,954.29 | $1,954.29 | $1,954.29–$1,954.29 | `10029` |
| Print Source Inc. | 1 | 1/30/2026 (1L) | $463.95 | $463.95 | $463.95–$463.95 | `10827` |
| Belt Power | 1 | 1/20/2026 (1L) | $0.00 | $0.00 | $0.00–$0.00 | `10930` |
| Scalesplus | 1 | 1/15/2026 (1L) | $324.52 | $324.52 | $324.52–$324.52 | `10929` |
| Sticker Mule | 1 | 1/5/2026 (2L) | $2,744.15 | $2,744.15 | $2,744.15–$2,744.15 | `10687` |
| The Ahimsa Alternative aka Neem Resource | 1 | 10/23/2025 (1L) | $2,400.00 | $2,400.00 | $2,400.00–$2,400.00 | `10054` |
| Vista Print | 1 | 10/21/2025 (1L) | $64.68 | $64.68 | $64.68–$64.68 | `10919` |
| Vibco | 1 | 9/30/2025 (1L) | $1,777.74 | $1,777.74 | $1,777.74–$1,777.74 | `10916` |
| Propac | 1 | 9/22/2025 (1L) | $4,460.80 | $4,460.80 | $4,460.80–$4,460.80 | `10887` |
| Tri River Appliance | 1 | 9/17/2025 (1L) | $841.88 | $841.88 | $841.88–$841.88 | `10914` |
| Global Industrial | 1 | 9/11/2025 (1L) | $1,185.47 | $1,185.47 | $1,185.47–$1,185.47 | `10342` |
| Ecowitt | 1 | 9/3/2025 (1L) | $395.88 | $395.88 | $395.88–$395.88 | `10765` |
| Bag Supply Co | 1 | 7/30/2025 (2L) | $19,080.00 | $19,080.00 | $19,080.00–$19,080.00 | `10896` |
| Berlin Packaging fka: Freund | 1 | 7/30/2025 (1L) | $44.50 | $44.50 | $44.50–$44.50 | `10817` |
| Berlin Packaging fka: Freund | 1 | 7/30/2025 (1L) | $68.10 | $68.10 | $68.10–$68.10 | `10034` |
| BuildASoil Soil Production | 1 | 7/30/2025 (1L) | $0.00 | $0.00 | $0.00–$0.00 | `10087` |
| Bulk Apothecary | 1 | 7/30/2025 (1L) | $45.08 | $45.08 | $45.08–$45.08 | `10673` |
| Mycorrhizal Applications | 1 | 7/14/2025 (1L) | $335.80 | $335.80 | $335.80–$335.80 | `10341` |
| Farmer Freeman | 1 | 7/1/2025 (1L) | $1,600.00 | $1,600.00 | $1,600.00–$1,600.00 | `10876` |
| Supply House | 1 | 6/25/2025 (1L) | $105.93 | $105.93 | $105.93–$105.93 | `10912` |
| Harbor Freight | 1 | 5/14/2025 (1L) | $23.87 | $23.87 | $23.87–$23.87 | `10769` |
| Arbico Organics | 1 | 5/6/2025 (0L) | $0.00 | $0.00 | $0.00–$0.00 | `10011` |

## Unmatched email evidence

These messages contained MOQ language but couldn't be tied to a Finale vendor by name overlap. Could be promotional fluff ("no minimum order!") or a vendor we don't have in Finale yet.

| Account | Date | From | Term | Subject |
|---|---|---|---|---|
| default | Tue, 24 Fe | VIVOSUN <website@vivosun.com> | minimum order requirement | Re: Wholesale Purchases |
| default | Tue, 24 Ma | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Tue, 24 Ma | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Fri, 20 Ma | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Mon, 16 Ma | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Fri, 13 Ma | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Thu, 12 Ma | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Tue, 10 Ma | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Mon, 9 Mar | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Mon, 9 Mar | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Fri, 6 Mar | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Fri, 6 Mar | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Thu, 5 Mar | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Fri, 27 Fe | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Wed, 25 Fe | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Wed, 25 Fe | Landon Gilbertson <landon@drivensol.com> | minimum order quantity | Re: Soil Bags |
| default | Mon, 12 Ja | <issac@superbpackaging.com> | minimum order quantity | RE: Custom Flexible Packaging Solutions/ Pouch Bags = Superb Packaging Inc. |
| default | Mon, 8 Sep | Info Account <info@pacifickelp.co> | minimum order quantity | Re: Kelpex Info |
| default | Wed, 27 Au | <issac@superbpackaging.com> | minimum order quantity | RE: Custom Flexible Packaging Solutions/ Pouch Bags = Superb Packaging Inc. |
| default | Tue, 26 Au | <issac@superbpackaging.com> | minimum order quantity | RE: Custom Flexible Packaging Solutions/ Pouch Bags = Superb Packaging Inc. |
| default | Tue, 19 Au | <issac@superbpackaging.com> | minimum order quantity | RE: Custom Flexible Packaging Solutions/ Pouch Bags = Superb Packaging Inc. |
| default | Tue, 19 Au | Info Account <info@pacifickelp.co> | minimum order quantity | Re: Kelpex Info |
| default | Fri, 15 Au | Info Account <info@pacifickelp.co> | minimum order quantity | Re: Kelpex Info |
| default | Fri, 13 Ju | "feedback@service.alibaba.com" <feedback@service.alibaba.com> | minimum order quantity | Urgent! wang has sent you a message |
| default | Thu, 12 Ju | "feedback@service.alibaba.com" <feedback@service.alibaba.com> | minimum order quantity | Bill, you have a message from wang! |

---

_Generated by `src/cli/moq-survey.ts` on 2026-05-05._
