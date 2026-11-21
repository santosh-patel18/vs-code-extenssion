const http = require('http');

async function createCleanTaskBSession() {
  const base = 'http://localhost:8790';
  const prompt = "Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as '***'. It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.";

  // 1. Create session
  const sRes = await fetch(`${base}/api/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: { name: 'forge-agent' } })
  });
  const sData = await sRes.json();
  const sessionId = sData.data?.id;
  console.log('Session ID:', sessionId);

  // 2. Set descriptive title
  await fetch(`${base}/api/v1/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Task B: Add flask config CLI command'
    })
  });

  // 3. Send turn
  try {
    const tRes = await fetch(`${base}/api/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({
        input: [{ type: 'user.message', content: prompt }]
      })
    });
    console.log('Turn status:', tRes.status);
    const text = await tRes.text();
    console.log('Turn stream preview:\n', text.slice(0, 500));
  } catch (e) {
    console.warn('Turn note:', e.message);
  }

  // Check updated session
  const finalRes = await fetch(`${base}/api/v1/sessions/${sessionId}`);
  const finalData = await finalRes.json();
  console.log('Final session summary:', JSON.stringify(finalData.data, null, 2));
}

createCleanTaskBSession();
