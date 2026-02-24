/**
 * @file    verify-pdf-editor.ts
 * @purpose Verifies the PDF editing and filling suite functionalities.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pdfEditor } from '../lib/pdf/editor';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

async function verifyEditor() {
    console.log("🛠️ Starting PDF Editor Verification...");

    // 1. Create a dummy PDF with a form field
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 400]);
    const form = pdfDoc.getForm();

    // Add a text field
    const textField = form.createTextField('vendor_name');
    textField.addToPage(page, { x: 50, y: 300, width: 200, height: 25 });

    // Add a checkbox
    const checkbox = form.createCheckBox('is_approved');
    checkbox.addToPage(page, { x: 50, y: 250, width: 25, height: 25 });

    const initialBuffer = Buffer.from(await pdfDoc.save());
    console.log("✅ Dummy PDF with form fields created.");

    // 2. Test Form Filling
    console.log("🖋️ Testing Form Filling...");
    const filledBuffer = await pdfEditor.fillForm(initialBuffer, {
        'vendor_name': 'BUILDASOIL L.L.C.',
        'is_approved': true
    });

    // 3. Test Watermarking
    console.log("💧 Testing Watermarking...");
    const watermarkedBuffer = await pdfEditor.addWatermark(filledBuffer, "TEST VERIFIED");

    // 4. Test Text Drawing
    console.log("✍️ Testing Text Drawing...");
    const finalBuffer = await pdfEditor.drawText(watermarkedBuffer, [
        { text: "INTERNAL USE ONLY", x: 50, y: 50, size: 20, color: { r: 0.8, g: 0, b: 0 } }
    ]);

    // 5. Save final result for manual inspection if needed
    const outputPath = path.join(process.cwd(), 'temp_test_result.pdf');
    fs.writeFileSync(outputPath, finalBuffer);
    console.log(`✅ Verification complete. File saved to: ${outputPath}`);
}

verifyEditor().catch(err => {
    console.error("❌ Verification failed:", err);
});
