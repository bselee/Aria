import { classifyShipmentEvidence } from './shipment-intelligence';

async function main() {
  try {
    // Classify all shipment evidence with direct import
    await classifyShipmentEvidence();
    console.log("Classification completed");
    process.exit(0);
  } catch (err) {
    console.error(`Classification failed: ${err.message}`);
    process.exit(1);
  }
}

export { main as default };