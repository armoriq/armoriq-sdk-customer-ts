/**
 * ArmorIQ Customer SDK - Quick Start Example
 * ==========================================
 * 
 * This example shows the simplest way to use ArmorIQ SDK:
 * 1. Create a plan
 * 2. Get a token
 * 3. Call a tool
 * 
 * ✨ NO GCP CREDENTIALS REQUIRED! ✨
 * Just provide your API key and you're ready to go.
 */

import { ArmorIQClient } from '../src';

async function main() {
  console.log('🚀 ArmorIQ Customer SDK - Quick Start');
  console.log('='.repeat(50));
  console.log('✨ No GCP credentials, no KMS, no service accounts!\n');

  // Step 1: Initialize client (JUST AN API KEY!)
  console.log('Step 1: Initializing client...');
  console.log('  💡 Tip: Get your API key from platform.armoriq.ai');

  const client = new ArmorIQClient({
    apiKey: process.env.ARMORIQ_API_KEY || 'demo-api-key',
    userId: process.env.USER_ID || 'demo-user',
    agentId: process.env.AGENT_ID || 'demo-agent',
    useProduction: false, // Use local development
  });
  console.log(`  ✅ Client initialized (user: ${process.env.USER_ID})\n`);

  // Step 2: Create a plan
  console.log('Step 2: Creating execution plan...');
  const plan = {
    goal: 'Get weather information for Boston',
    steps: [
      {
        action: 'get_weather',
        tool: 'get_weather',
        mcp: 'weather-mcp',
        params: { city: 'Boston' },
        description: 'Fetch current weather for Boston',
      },
    ],
  };

  const planCapture = client.capturePlan('gpt-4', "What's the weather in Boston?", plan);
  console.log(`  ✅ Plan created: ${plan.goal}\n`);

  // Step 3: Get access token (backend handles all crypto!)
  console.log('Step 3: Getting access token...');
  console.log('  🔒 Backend handles Ed25519 signing & Merkle proofs');
  const token = await client.getIntentToken(planCapture, undefined, 3600);
  console.log('  ✅ Token obtained (expires in 1 hour)\n');

  // Step 4: Call the tool
  console.log('Step 4: Calling weather tool...');
  try {
    const result = await client.invoke('weather-mcp', 'get_weather', token, {
      city: 'Boston',
    });

    // Step 5: Display results
    console.log('  ✅ Tool execution successful!');
    console.log('\n📊 Result:');
    console.log(`   ${JSON.stringify(result.result, null, 2)}\n`);
  } catch (error: any) {
    console.log(`  ❌ Tool execution failed: ${error.message}\n`);
  }

  console.log('='.repeat(50));
  console.log('🎉 Done! That\'s how easy it is to use ArmorIQ SDK.');
  console.log('\n💡 Key Takeaway: No GCP setup required!');
  console.log('   - No service account JSON files');
  console.log('   - No KMS configuration');
  console.log('   - Just your API key!');

  client.close();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌ Error: ${error.message}`);
    console.log('\n💡 Troubleshooting:');
    console.log('   1. Check your API key at platform.armoriq.ai');
    console.log('   2. Ensure Weather MCP is running');
    console.log('   3. Verify endpoints are accessible');
    process.exit(1);
  });
}
