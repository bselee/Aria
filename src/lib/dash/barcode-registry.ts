/**
 * @file    src/lib/dash/barcode-registry.ts
 * @purpose Official barcode source of truth for BuildASoil products.
 *          Extracted from OfficialBarcodes.xlsx (209 products with barcodes).
 *
 *          This is THE source for barcode verification. When the Dash
 *          artwork barcode reader finds a barcode on a label PDF, it's
 *          compared against this registry to confirm it matches what
 *          Finale expects for that SKU.
 *
 *          Auto-generated from spreadsheet. To regenerate:
 *            python scripts/export-barcodes.py
 *
 * @author  Hermia
 * @created 2026-06-22
 * @deps    none
 */

export interface BarcodeEntry {
    sku: string;
    description: string;
    upc: string;
    grade?: string;
}

/**
 * Official UPC barcode registry — 209 products with barcodes.
 * Keyed by SKU (uppercase-sensitive, matches spreadsheet exactly).
 *
 * EAN13 barcodes from labels typically read as "0810166421515"
 * (13 digits with leading zero). The registry stores "810166421515"
 * (12 digits, no leading zero). normalizeBarcode() handles comparison.
 */
export const FULL_BARCODE_REGISTRY: Record<string, string> = {
  'ACB01': '810166420396',
  'ACB02': '810166420402',
  'ACB03': '810166420419',
  'ACI605': '819137021570',
  'ACI709': '819137023741',
  'ADZ01': '728028331776',
  'ADZ02': '728028331790',
  'AG101': '810166420426',
  'AG102': '810166420433',
  'AG104': '810166420440',
  'AG110': '810166421591',
  'AG111': '810166421607',
  'AG112': '810166421614',
  'AIR1744': '816731016704',
  'AL101': '810166421324',
  'AL104': '810166421331',
  'AL106': '810166421348',
  'AL107': '810166421355',
  'BAF00': '810166421492',
  'BAF01': '810166421508',
  'BAF02': '810166421058',
  'BAF03': '810166421065',
  'BASBBL02': '810166420457',
  'BASEM5-102': '810166420556',
  'BASEM5-103': '810166420563',
  'BASEM5-106': '810166420570',
  'BASLIGHT102': '810166420112',
  'BASLIGHT107': '810166420105',
  'BASLIGHT109': '810166421676',
  'BASLPEE102': '735203783114',
  'BASLPEE103': '200000222772',
  'BASTM6-102': '810166420310',
  'BASTM6-103': '810166420327',
  'BASTM6-104': '810166420334',
  'BASTM6-105': '810166421690',
  'BAV101': '810166420075',
  'BAV102': '810166420082',
  'BAV103': '810166420099',
  'BB101': '810166420488',
  'BB105': '810166420501',
  'BB108': '810166420518',
  'BBP102': '810166420525',
  'BBP103': '810166420532',
  'BBP104': '810166420549',
  'BBV101': '810166420846',
  'BBV102': '810166420853',
  'BBV105': '810166420860',
  'BC102C': '810166421119',
  'BC104C': '810166421133',
  'BC105C': '810166421140',
  'BLV07': '810166421669',
  'BLV08': '810166421652',
  'BMG102': '649531040149',
  'BS102': '810166421294',
  'BS103': '810166421300',
  'BS106': '810166421317',
  'CAB01': '810166421423',
  'CAB02': '810166421416',
  'CAB03': '810166421409',
  'CFP01': '810166421393',
  'CHC101': '810052838465',
  'CHC102': '868812000010',
  'CJD101': '037321002529',
  'CLB102': '810166421621',
  'CLB103': '810166421638',
  'CLVR02': '810166420143',
  'CLVR03': '810166420150',
  'CLVR04': '810166421430',
  'CLVR05': '810166421461',
  'CLVR06': '810166420136',
  'CNB101': '860003356005',
  'COW102': '810166420822',
  'COW103': '810166420839',
  'CRAFT1': '810166420006',
  'CRAFT10': '810166421430',
  'CRAFT4': '810166420020',
  'CRAFT8': '810166420037',
  'CWP01': '810166420204',
  'CWP02': '810166420198',
  'CWP03': '810166420181',
  'CWP05': '810166420174',
  'CWP07': '810166420167',
  'DBP101': '810166421454',
  'DLS105': '810166420877',
  'EBA104': '026978811219',
  'EM102': '857970000239',
  'EM103': '857970000253',
  'EM108': '857970000246',
  'FR107': '810166420716',
  'FR109': '810166420730',
  'FWE101': '725272730713',
  'FWE102': '725272730706',
  'FWI101': '725272730775',
  'FWI102': '725272730782',
  'GA104': '810166420211',
  'GA105': '810166420228',
  'GA106': '810166420235',
  'GA107': '810166420242',
  'GLP101': '665415351217',
  'GLP103': '665415371253',
  'GLP104': '665415197068',
  'GLP112': '665415222838',
  'GLP113': '665415041019',
  'GLP114': '665415314175',
  'GLP115': '665415217902',
  'GLP116': '665415457353',
  'GLP117': '665415142426',
  'GST101': '856372001219',
  'GnarBar01': '810166420259',
  'GnarBar02': '810166420266',
  'GnarBar04': '810166420273',
  'GnarBar06': '810166420280',
  'GnarBar07': '810166420297',
  'GnarBar09': '810166420303',
  'HER101': '860000177610',
  'HSS105': '810166421522',
  'HSS107': '810166421539',
  'HTF101': '735203823742',
  'HTF102': '735203678120',
  'KGD103': '810166421706',
  'KGD104': '810166421645',
  'KGD204': '810166421645',
  'LOSOLY3': '810166420044',
  'LOSOLY3SMB': '810166421683',
  'LOSOLY3x3YARD': '810166420068',
  'LY102': '893637002031',
  'MC101': '705105669649',
  'MGG104': '662835022505',
  'MK101': '810166420747',
  'MK103': '810166420761',
  'MK104': '810166420778',
  'MTD102': '810166420891',
  'MTD103': '810166420884',
  'NIB101': '810166421546',
  'NIB102': '810166421553',
  'NIB103': '810166421560',
  'NK101': '810166420594',
  'NK102': '810166420600',
  'NK103': '810166420617',
  'NK104': '810166420624',
  'NK105': '810166420631',
  'NKC03': '810166420792',
  'NKC04': '810166420808',
  'OAG103': '644216892969',
  'OAG104': '632963363573',
  'OAG109': '644216896165',
  'OAG110': '644216895465',
  'OAG201': '644216896363',
  'OAG202': '644216892068',
  'OAG203': '644216891962',
  'OAG204': '644216896462',
  'OAG205': '644216891863',
  'OAG206': '644216892167',
  'OAG214': '644216893164',
  'OAG215': '644216893263',
  'OAG216': '644216892860',
  'OAG217': '632963363597',
  'OAG218': '644216892761',
  'OAG219': '646223405217',
  'OAG222': '644216891764',
  'OAG226': '632963363597',
  'OAG227': '632963363573',
  'OAG228': '646223405217',
  'OAG229': '646223405217',
  'OCB101': '810166420969',
  'OCB102': '810166420952',
  'OCB103': '810166420945',
  'OGF101': '683649000329',
  'ORS101': '860007872815',
  'PBH02': '035200202114',
  'PBH04': '810166420976',
  'PNP101': '810166421386',
  'PNP104': '810166421478',
  'PNP105': '810166421485',
  'PRMA103': '810166421003',
  'PU104': '810166421515',
  'PU105': '810166420655',
  'PU106': '810166420662',
  'QUE103': '810166420372',
  'QUE104': '810166420365',
  'QUE105': '810166420358',
  'RAK101': '810166421171',
  'RAK102': '810166421188',
  'RAK103': '810166421195',
  'RAK104': '810166421201',
  'RMB104': '810166421584',
  'RR50': '659627011076',
  'SAP02': '810166421089',
  'SAP08': '810166421096',
  'SAP10': '810166421102',
  'SBK101': '810166421256',
  'SBK102': '810166421249',
  'SBK103': '810166421232',
  'SCO102': '704521549825',
  'SCO104': '686162993093',
  'SEA102': '850034199160',
  'ST101': '849969022773',
  'ST102': '849969022780',
  'TB101': '713757640237',
  'TEC101': '818031000032',
  'TEC102': '818031000063',
  'TEC103': '818031000087',
  'UCS104': '810166421027',
  'UCS105': '810166421010',
  'WP101': '810166420679',
  'WP104': '810166420693',
  'WTR102': '850624002832',
  'ZPK101': '643459333314',
  'ZPS101': '643459332843',
};

/**
 * Look up the expected barcode for a given SKU.
 * Case-sensitive — tries exact match first, then case-insensitive,
 * then falls back to fuzzy substring match.
 */
export function getBarcodeForSku(sku: string): string | null {
    const direct = FULL_BARCODE_REGISTRY[sku];
    if (direct) return direct;

    // Case-insensitive
    const upper = sku.toUpperCase();
    const ci = Object.entries(FULL_BARCODE_REGISTRY).find(([key]) =>
        key.toUpperCase() === upper
    );
    if (ci) return ci[1];

    // Fuzzy — if sku contains a registry key or vice versa
    const fuzzy = Object.entries(FULL_BARCODE_REGISTRY).find(([key]) =>
        upper.includes(key.toUpperCase()) || key.toUpperCase().includes(upper)
    );
    return fuzzy ? fuzzy[1] : null;
}

/**
 * Check if a scanned barcode matches the expected barcode for a SKU.
 * Normalizes both sides (strip leading zeros, spaces, hyphens) before comparing.
 */
export function barcodeMatches(sku: string, scannedBarcode: string): boolean {
    const expected = getBarcodeForSku(sku);
    if (!expected) return false;

    const normalize = (b: string) => b.replace(/[\s-]/g, '').replace(/^0+/, '');
    return normalize(scannedBarcode) === normalize(expected);
}
