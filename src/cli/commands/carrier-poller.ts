import * as tracking from '../../lib/tracking/shipment-intelligence';

async function main() {
  try {
    const newShipments = await tracking.classifyShipmentEvidence();

    console.log(`Processed ${newShipments.length} new shipments`);
    if (newShipments.some(s => s.status === 'exception')) {
      console.warn('⚠️ Tracking exceptions detected');
    }
    process.exit(0);
  } catch (err) {
    console.error(`🚨 Pipeline failure: ${err.message}`);
    process.exit(1);
  }
}

main();