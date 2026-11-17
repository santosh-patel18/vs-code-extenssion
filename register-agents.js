/**
 * Registration script for Forge agent definitions (FR-TF-03 & AT-G)
 * Registers or updates forge-inline, forge-agent, and forge-fallback in TrueForge.
 */

const fs = require('fs');
const path = require('path');

const TF_BASE_URL = process.env.TRUEFORGE_URL || 'http://localhost:8790';

async function registerAgent(filePath) {
  const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  console.log(`Checking agent: ${content.name}...`);

  try {
    // Check if agent already exists
    const listRes = await fetch(`${TF_BASE_URL}/api/v1/agents`);
    const listJson = await listRes.json();
    const existing = (listJson.data || []).find(a => a.name === content.name);

    if (existing) {
      console.log(`✓ Agent "${content.name}" is already registered (id: ${existing.id}).`);
      return;
    }

    // Register agent
    const res = await fetch(`${TF_BASE_URL}/api/v1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: content.name,
        description: content.description,
        manifest: {
          model: { name: content.model },
          instructions: content.instructions,
          config: {
            iteration_limit: content.iteration_limit || 20
          }
        }
      })
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`✓ Successfully registered "${content.name}" (id: ${data.data?.id})`);
    } else {
      const err = await res.text();
      console.error(`✗ Failed to register "${content.name}":`, err);
    }
  } catch (err) {
    console.error(`✗ Error connecting to TrueForge at ${TF_BASE_URL}:`, err.message);
  }
}

async function main() {
  console.log(`Connecting to TrueForge at ${TF_BASE_URL}...`);
  const agentsDir = path.join(__dirname, 'agents');
  const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    await registerAgent(path.join(agentsDir, file));
  }
  console.log('Done registering agents.');
}

main();
