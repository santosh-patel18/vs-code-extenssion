/**
 * Registration script for Forge agent definitions (FR-TF-03 & AT-G)
 * Registers or updates forge-inline, forge-agent, and forge-fallback in TrueForge.
 */

const fs = require('fs');
const path = require('path');

const TF_BASE_URL = process.env.TRUEFORGE_URL || 'http://localhost:8790';

async function registerOrUpdateAgent(filePath) {
  const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  console.log(`Configuring agent: ${content.name}...`);

  try {
    // Check if agent already exists
    const listRes = await fetch(`${TF_BASE_URL}/api/v1/agents`);
    const listJson = await listRes.json();
    const existing = (listJson.data || []).find(a => a.name === content.name);

    const manifestPayload = {
      model: {
        name: content.model,
        params: { reasoning_effort: 'medium' }
      },
      instructions: content.instructions,
      mcp_servers: [
        {
          name: 'forge-tools',
          enable_tools: ['@all']
        }
      ],
      config: {
        iteration_limit: content.iteration_limit || 20
      }
    };

    if (existing) {
      // Update existing agent with tools & instructions
      const updateRes = await fetch(`${TF_BASE_URL}/api/v1/agents/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest: manifestPayload })
      });
      if (updateRes.ok) {
        console.log(`✓ Updated "${content.name}" (id: ${existing.id}) with MCP tools & instructions.`);
      } else {
        console.error(`✗ Failed to update "${content.name}":`, await updateRes.text());
      }
      return;
    }

    // Register new agent
    const res = await fetch(`${TF_BASE_URL}/api/v1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: content.name,
        description: content.description,
        manifest: manifestPayload
      })
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`✓ Successfully registered "${content.name}" (id: ${data.data?.id}) with MCP tools.`);
    } else {
      const err = await res.text();
      console.error(`✗ Failed to register "${content.name}":`, err);
    }
  } catch (err) {
    console.error(`✗ Error connecting to TrueForge at ${TF_BASE_URL}:`, err.message);
  }
}

async function registerMcpServer() {
  console.log('Registering forge-tools in TrueForge settings...');
  try {
    await fetch(`${TF_BASE_URL}/api/v1/settings/mcp-servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: {
          type: 'remote',
          name: 'forge-tools',
          url: 'http://127.0.0.1:8899/mcp',
          description: 'Forge VS Code extension editor capabilities'
        }
      })
    });
    console.log('✓ forge-tools registered in TrueForge.');
  } catch (e) {
    console.warn('Note on MCP registration:', e.message);
  }
}

async function main() {
  console.log(`Connecting to TrueForge at ${TF_BASE_URL}...`);
  await registerMcpServer();

  const agentsDir = path.join(__dirname, 'agents');
  const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    await registerOrUpdateAgent(path.join(agentsDir, file));
  }
  console.log('Done registering/updating agents.');
}

main();
