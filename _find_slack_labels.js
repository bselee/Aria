const fs = require('fs');
const envText = fs.readFileSync('.env.local', 'utf8');
const tokenLine = envText.split('\n').filter(l => l.startsWith('SLACK_ACCESS_TOKEN='))[0];
const SLACK_TOKEN = tokenLine.split('=')[1].trim();

async function main() {
  // Search ALL messages containing labeling keywords across all channels
  const channels = [
    {id: 'C0BMX34NR', name: 'general'},
    {id: 'CB9KJMGN7', name: 'shipping'},
    {id: 'C03V6V9GSDV', name: 'quality-control'},
    {id: 'C05EBJ4MGCR', name: 'purchasing'},
    {id: 'C022Z7LTBRD', name: 'shipping-calculator-issues'},
  ];
  
  // Also get ALL public/private channels
  const allResp = await fetch('https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200', {
    headers: {Authorization: *** ' + SLACK_TOKEN}
  });
  const allData = await allResp.json();
  console.log('Total channels:', allData.channels?.length || 0);
  
  const allChannels = allData.channels || [];
  const moreChannels = allChannels.filter(c => !channels.find(x => x.id === c.id));
  
  for (const ch of moreChannels) {
    channels.push({id: ch.id, name: ch.name});
  }
  
  const keywords = ['gnarbar', 'gnar bar', 'pumice', 'craft label', 'wrong barcode', 'missing weight', 'milled', 'labeling', 'labels wrong', 'quinton'];
  const todayStart = Math.floor(Date.now() / 1000) - 86400 * 3; // last 3 days
  
  for (const ch of channels) {
    const histResp = await fetch('https://slack.com/api/conversations.history?channel=' + ch.id + '&limit=100', {
      headers: {Authorization: *** ' + SLACK_TOKEN}
    });
    const hist = await histResp.json();
    
    let found = 0;
    for (const m of hist.messages || []) {
      const text = (m.text || '').toLowerCase();
      const hasKeyword = keywords.some(k => text.includes(k));
      if (!hasKeyword) continue;
      
      if (found === 0) {
        console.log('\n=== #' + ch.name + ' (' + ch.id + ') ===');
      }
      found++;
      
      const t = new Date(parseFloat(m.ts) * 1000);
      // Get user name
      let userName = m.user;
      try {
        const uResp = await fetch('https://slack.com/api/users.info?user=' + m.user, {
          headers: {Authorization: *** ' + SLACK_TOKEN}
        });
        const uData = await uResp.json();
        userName = uData.user?.real_name || uData.user?.name || m.user;
      } catch(e) {}
      
      console.log(t.toISOString() + ' ' + userName + ' (' + m.user + ')');
      console.log((m.text || '').substring(0, 600));
      
      // Get thread replies
      if (m.thread_ts) {
        const repliesResp = await fetch('https://slack.com/api/conversations.replies?channel=' + ch.id + '&ts=' + m.thread_ts + '&limit=50', {
          headers: {Authorization: *** ' + SLACK_TOKEN}
        });
        const replies = await repliesResp.json();
        for (const r of replies.messages || []) {
          if (r.ts === m.thread_ts) continue;
          let rName = r.user;
          try {
            const ruResp = await fetch('https://slack.com/api/users.info?user=' + r.user, {
              headers: {Authorization: *** ' + SLACK_TOKEN}
            });
            const ruData = await ruResp.json();
            rName = ruData.user?.real_name || r.user;
          } catch(e) {}
          console.log('  > ' + rName + ': ' + (r.text || '').substring(0, 300));
        }
      }
      console.log('---');
    }
    if (found === 0) {
      console.log('#' + ch.name + ': no matches in last 100');
    }
  }
}

main().catch(e => console.error(e));
