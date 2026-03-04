import * as dotenv from 'dotenv';
import { BoxAgent } from '../src/lib/agents/box-agent';

dotenv.config({ path: '.env.local' });

async function test() {
    const agent = new BoxAgent();

    const text = `hey man I stocked all of our stations this am and got counts on things these are the box sizes I think we should put on the next Uline order 9X5x5 we have 0 on hand now and we use them so does @MFG for case builds 12x6x6 we have 0 on hand now and we use them so does MFG for case builds 12x12x6 we have 500 on hand (1 pallet) and all 3 departments use them @Soil for barley straw we use them so does MFG for case builds 12x12x12 450 on hand all 3 departments use them Soil for barley straw we use them so does MFG for case builds 22x14x6 760 on hand (3 pallets) we use a pallet a day now that it is our main box and 24x14x10 we have 0 on hand and that is the box MFG uses to transfer their products and we use them as well 😁`;

    console.log("Analyzing message...");
    const report = await agent.analyzeSlackMessage(text);
    console.log("===== REPORT =====");
    console.log(report);
}

test();
