/**
 * ArmorIQ SDK - Complete Workflow Example
 * ========================================
 * 
 * Demonstrates a complete workflow with:
 * - Plan creation with multiple steps
 * - Token issuance
 * - Sequential action invocation
 * - Error handling
 * - Token verification
 */

import { ArmorIQClient, IntentToken, TokenExpiredException, IntentMismatchException } from '../src';

async function main() {
  console.log('🚀 ArmorIQ SDK - Complete Workflow Example\n');

  // Initialize client
  const client = new ArmorIQClient({
    apiKey: process.env.ARMORIQ_API_KEY || 'demo-api-key',
    userId: process.env.USER_ID || 'demo-user',
    agentId: process.env.AGENT_ID || 'demo-agent',
    useProduction: false,
  });

  // Create a multi-step plan
  const plan = {
    goal: 'Get weather and provide travel recommendation',
    steps: [
      {
        action: 'get_weather',
        mcp: 'weather-mcp',
        params: { city: 'Boston' },
      },
      {
        action: 'get_weather',
        mcp: 'weather-mcp',
        params: { city: 'New York' },
      },
      {
        action: 'analyze_travel',
        mcp: 'travel-mcp',
        params: { from: 'Boston', to: 'New York' },
      },
    ],
  };

  console.log('📋 Plan created with', plan.steps.length, 'steps\n');

  // Capture plan
  const planCapture = client.capturePlan(
    'gpt-4',
    'Should I travel from Boston to New York today?',
    plan,
    { priority: 'high', category: 'travel' }
  );

  // Get intent token
  console.log('🔐 Requesting intent token...');
  const token = await client.getIntentToken(planCapture, undefined, 300); // 5 min validity
  console.log(`✅ Token issued: ${token.tokenId}`);
  console.log(`   Expires in: ${IntentToken.timeUntilExpiry(token).toFixed(0)}s\n`);

  // Verify token
  const isValid = await client.verifyToken(token);
  console.log(`🔍 Token verification: ${isValid ? '✅ Valid' : '❌ Invalid'}\n`);

  // Execute steps sequentially
  console.log('🎯 Executing plan steps:\n');

  // Step 1: Get Boston weather
  try {
    console.log('Step 1: Getting Boston weather...');
    const result1 = await client.invoke('weather-mcp', 'get_weather', token, {
      city: 'Boston',
    });
    console.log(`✅ Boston weather: ${JSON.stringify(result1.result)}\n`);
  } catch (error: any) {
    console.error(`❌ Step 1 failed: ${error.message}\n`);
  }

  // Step 2: Get New York weather
  try {
    console.log('Step 2: Getting New York weather...');
    const result2 = await client.invoke('weather-mcp', 'get_weather', token, {
      city: 'New York',
    });
    console.log(`✅ New York weather: ${JSON.stringify(result2.result)}\n`);
  } catch (error: any) {
    console.error(`❌ Step 2 failed: ${error.message}\n`);
  }

  // Step 3: Analyze travel
  try {
    console.log('Step 3: Analyzing travel recommendation...');
    const result3 = await client.invoke('travel-mcp', 'analyze_travel', token, {
      from: 'Boston',
      to: 'New York',
    });
    console.log(`✅ Travel analysis: ${JSON.stringify(result3.result)}\n`);
  } catch (error: any) {
    console.error(`❌ Step 3 failed: ${error.message}\n`);
  }

  // Try to invoke an action NOT in the plan (should fail)
  console.log('🚫 Testing intent mismatch protection...');
  try {
    await client.invoke('weather-mcp', 'get_forecast', token, {
      city: 'Chicago',
    });
    console.log('❌ Should have failed - action not in plan!\n');
  } catch (error: any) {
    if (error instanceof IntentMismatchException) {
      console.log('✅ Intent mismatch correctly detected\n');
    } else {
      console.error(`❌ Unexpected error: ${error.message}\n`);
    }
  }

  // Check token expiry
  console.log(`⏰ Token expires in: ${IntentToken.timeUntilExpiry(token).toFixed(0)}s`);
  console.log(`   Is expired: ${IntentToken.isExpired(token) ? 'Yes' : 'No'}\n`);

  console.log('✅ Workflow complete!');
  client.close();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌ Fatal error: ${error.message}`);
    process.exit(1);
  });
}
