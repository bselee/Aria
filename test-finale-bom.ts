import { FinaleClient } from './src/lib/finale/client';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
const client = new FinaleClient();
client.getBillOfMaterials('LOSOLY3x3YARD').then(console.log);
