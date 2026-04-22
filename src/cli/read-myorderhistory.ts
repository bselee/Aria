import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import * as xlsx from 'xlsx';
import path from 'path';

const filePath = 'C:/Users/BuildASoil/OneDrive/Desktop/Sandbox/ULINE/MyOrderHistory.xlsx';

const workbook = xlsx.readFile(filePath);
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

console.log("Sheet dimensions:", worksheet['!ref']);
console.log("First few rows:");
data.slice(0, 10).forEach((row: any, i) => {
    console.log(`Row ${i}:`, JSON.stringify(row));
});
