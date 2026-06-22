/**
 * sop-hub-publisher.js
 * 
 * Reads SOP markdown files from sops/ and generates a browser console script
 * to publish them to the BuildASoil SOP Hub (build-a-soil-sop-hub.vercel.app).
 * 
 * Usage:
 *   node scripts/sop-hub-publisher.js          # print to stdout
 *   node scripts/sop-hub-publisher.js | clip   # copy to clipboard
 * 
 * Workflow:
 *   1. Edit SOPs in sops/<department>/*.md
 *   2. Run this script to generate the paste
 *   3. Paste into browser console on SOP Hub page
 */

const fs = require('fs');
const path = require('path');

const SOPS_DIR = path.join(__dirname, '..', 'sops');

/**
 * Parse a SOP markdown file into the hub's JSON format.
 * 
 * Expected markdown structure:
 *   ---
 *   title: Purchase Order Creation...
 *   status: draft
 *   department: Purchasing
 *   ---
 *   ## Purpose
 *   ...
 *   ## When to Use
 *   ...
 *   ## Sections
 *   ### Section Title
 *   1. Step one
 *   2. Step two
 *   ...
 *   ## Quality
 *   - Check one
 *   ## Cross-Department
 *   - Note one
 *   ## Related SOPs
 *   - SOP Name
 *   ## Troubleshooting
 *   - Problem: Solution
 */
function parseSOP(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  
  // Parse YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) {
    console.error('No frontmatter found in:', filePath);
    return null;
  }
  
  const fmLines = fmMatch[1].split('\n');
  const fm = {};
  let currentKey = null;
  let inArray = false;
  
  fmLines.forEach(line => {
    // Empty line resets array context
    if (line.trim() === '') { 
      if (!inArray) currentKey = null; 
      return; 
    }
    
    const kvMatch = line.match(/^(\w+):\s*(.*)/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      let val = kvMatch[2].trim();
      inArray = false;
      
      if (val === '') {
        // This is an array that starts on next lines
        inArray = true;
        fm[currentKey] = [];
      } else if (val.startsWith('[') && val.endsWith(']')) {
        fm[currentKey] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^"/, '').replace(/"$/, '').replace(/^'/, '').replace(/'$/, ''));
      } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        fm[currentKey] = val.slice(1, -1);
      } else if (val === 'true') fm[currentKey] = true;
      else if (val === 'false') fm[currentKey] = false;
      else fm[currentKey] = val;
    } else if (currentKey && inArray && line.trim().startsWith('- ')) {
      const item = line.trim().slice(2).trim().replace(/^"/, '').replace(/"$/, '').replace(/^'/, '').replace(/'$/, '');
      if (item) {
        if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
        fm[currentKey].push(item);
      }
    }
  });
  
  const body = content.slice(fmMatch[0].length);
  
  // Extract sections
  const sections = [];
  const sectionPattern = /### (.+)\n([\s\S]*?)(?=\n### |\n## |$)/g;
  let sectionMatch;
  
  // First find all ## headings to know what's what
  const purpose = extractSection(body, 'Purpose');
  const when = extractSection(body, 'When to Use');
  const risk = extractSection(body, 'Risk');
  const qualityRaw = extractSection(body, 'Quality');
  const crossDept = extractSection(body, 'Cross-Department');
  const relatedRaw = extractSection(body, 'Related SOPs');
  const troubleshootingRaw = extractSection(body, 'Troubleshooting');
  const sectionsBody = extractSection(body, 'Sections') || body;
  
  // Parse subsections from the Sections area
  const subRe = /### (.+)\n([\s\S]*?)(?=\n### |\n## |$)/g;
  let m;
  while ((m = subRe.exec(sectionsBody)) !== null) {
    const steps = m[2].split('\n')
      .map(l => l.replace(/^\d+\.\s*/, '').trim())
      .filter(l => l.length > 0 && !l.startsWith('//') && !l.startsWith('#') && !l.startsWith('---'));
    sections.push({
      title: m[1].trim(),
      steps: steps,
      video: '',
      image: '',
      links: []
    });
  }
  
  // Parse quality as array
  const quality = qualityRaw ? qualityRaw.split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(l => l.length > 0) : [];
  
  // Parse cross-dept as array
  const crossDeptArr = crossDept ? crossDept.split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(l => l.length > 0) : [];
  
  // Parse related SOPs as array
  const relatedSops = relatedRaw ? relatedRaw.split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(l => l.length > 0) : [];
  
  // Parse troubleshooting as array of [problem, solution] pairs
  const troubleshooting = troubleshootingRaw ? troubleshootingRaw.split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(l => l.length > 0)
    .map(l => {
      const colonIdx = l.indexOf(':');
      if (colonIdx > 0) {
        return [l.slice(0, colonIdx).trim(), l.slice(colonIdx + 1).trim()];
      }
      return [l, ''];
    }) : [];
  
  return {
    title: fm.title || path.basename(filePath, '.md'),
    status: fm.status || 'draft',
    department: fm.department || 'Purchasing',
    usedBy: Array.isArray(fm.usedBy) ? fm.usedBy : (fm.usedBy ? [fm.usedBy] : []),
    access: fm.access || 'public',
    owner: fm.owner || 'Responsible Role: Staff',
    platforms: Array.isArray(fm.platforms) ? fm.platforms : (fm.platforms ? [fm.platforms] : []),
    purpose: purpose || '',
    when: when || '',
    risk: risk || '',
    sections: sections,
    quality: quality,
    crossDept: crossDeptArr,
    related_sops: relatedSops,
    troubleshooting: troubleshooting,
    category: fm.category || ''
  };
}

function extractSection(body, heading) {
  const re = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);
  const m = re.exec(body);
  return m ? m[1].trim() : '';
}

function generate() {
  // Find all .md files in sops/ recursively
  const files = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.forEach(e => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) files.push(full);
    });
  }
  walk(SOPS_DIR);
  
  if (files.length === 0) {
    console.error('No SOP files found in', SOPS_DIR);
    process.exit(1);
  }
  
  const sops = files.map(parseSOP).filter(Boolean);
  
  if (sops.length === 0) {
    console.error('No valid SOPs parsed.');
    process.exit(1);
  }
  
  // Generate the browser console script
  const lines = [];
  lines.push("(function(){");
  lines.push("var s=JSON.parse(localStorage.getItem('bas_sops')||'[]');");
  lines.push("var n=1;s.forEach(function(x){var m=x.id&&x.id.match(/^sop-(\\d+)$/);if(m)n=Math.max(n,parseInt(m[1])+1)});");
  
  sops.forEach(function(sop, i) {
    // Build the SOP object as JSON, then patch the ID
    const json = JSON.stringify(sop);
    const patched = json.replace(/"id":"[^"]*"/, '"id":sop-"+(n+' + i + ')+"');
    // If no id in the JSON, we need to add it differently
    const finalJson = json.includes('"id"') 
      ? patched 
      : json.slice(0, -1) + ',"id":"sop-"+(n+' + i + ')+""}';
    lines.push("s.push(" + finalJson + ");");
  });
  
  lines.push("localStorage.setItem('bas_sops',JSON.stringify(s));");
  lines.push("if(typeof SL!=='undefined'&&SL.sops&&typeof renderSidebar==='function'){SL.sops=s;renderSidebar('"+sops[0].department+"');}");
  lines.push("console.log('Published "+sops.length+" SOPs to "+sops[0].department+". Total: '+s.length);");
  lines.push("})();");
  
  return lines.join('\n');
}

// If run directly
if (require.main === module) {
  const result = generate();
  console.log(result);
  console.error('\n---');
  console.error('Copy the above output and paste into browser console on the SOP Hub page.');
  console.error('Make sure you click the target department in the sidebar first.');
}

module.exports = { generate, parseSOP };
