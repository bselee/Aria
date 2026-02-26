import { WebClient } from '@slack/web-api';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
console.log('Sending...', process.env.SLACK_BOT_TOKEN ? 'TOKEN FOUND' : 'NO TOKEN');
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
slack.chat.postMessage({ channel: '#purchasing', text: 'Diagnostic test' })
    .then(r => console.log('OK', r.ok))
    .catch(console.error);
