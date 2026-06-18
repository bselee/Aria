// carrier-poll → carrierPoll (alias)
import { sendTelegramNotify } from "../lib/intelligence/telegram-notify";
import carrierPoller from "../lib/tracking/carrier-poller";
import { classifyShipmentEvidence } from "../lib/tracking/shipment-intelligence";

async function runCarrierPoll() {
  try {
    await carrierPoller();
    console.log("poll executed");
  } catch (error) {
    console.warn(`[carrier-poll] ${error.message}`);
    await sendTelegramNotify(`⚠️ Error in carrier poll: ${error.message}`);
  }
}

if (require.main === module) {
  runCarrierPoll();
}
