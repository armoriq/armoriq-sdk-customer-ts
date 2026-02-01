# ArmorIQ SDK (TypeScript)

**Build secure AI agents with cryptographic intent verification.**

The ArmorIQ SDK enables developers to build AI agents with built-in security and auditability. Just one API key - no cloud complexity.

---

## Why ArmorIQ?

- **Simple** - Just one API key, no cloud credentials
- **Secure** - Cryptographic verification for every action
- **Auditable** - Complete execution trail
- **Fast** - Get started in 5 minutes

---

## Installation

```bash
npm install @armoriq/sdk
# or
yarn add @armoriq/sdk
```

---

## Quick Start

### 1. Get Your API Key

Visit [platform.armoriq.ai](https://platform.armoriq.ai) to generate your API key.

### 2. Initialize the Client

```typescript
import { ArmorIQClient } from '@armoriq/sdk';

const client = new ArmorIQClient({
  apiKey: 'ak_your_key_here',
  userId: 'your-user-id',
  agentId: 'your-agent-id',
});
```

### 3. Capture Your Plan

```typescript
const plan = {
  goal: 'Get weather forecast',
  steps: [
    {
      action: 'get_weather',
      tool: 'weather_api',
      mcp: 'weather-mcp',
      inputs: { city: 'Boston' },
    },
  ],
};

const planCapture = client.capturePlan('gpt-4', "What's the weather in Boston?", plan);
```

### 4. Get Intent Token

```typescript
const token = await client.getIntentToken(planCapture);
```

### 5. Invoke Actions

```typescript
const result = await client.invoke('weather-mcp', 'get_weather', token, {
  city: 'Boston',
});

console.log(result);
```

---

## Environment Variables

```bash
# Required
ARMORIQ_API_KEY=ak_your_key_here
USER_ID=your-user-id
AGENT_ID=your-agent-id

# Optional
ARMORIQ_ENV=production  # or 'development' for local
CONTEXT_ID=default
IAP_ENDPOINT=https://customer-iap.armoriq.ai
PROXY_ENDPOINT=https://customer-proxy.armoriq.ai
BACKEND_ENDPOINT=https://customer-api.armoriq.ai
```

---

## Advanced Usage

### Delegation

```typescript
import * as crypto from 'crypto';

// Generate delegate keypair
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');

const delegation = await client.delegate(token, pubKeyHex, 1800);
console.log(`Delegated token: ${delegation.delegatedToken.tokenId}`);
```

### Custom Proxy Endpoints

```typescript
const client = new ArmorIQClient({
  apiKey: 'ak_your_key_here',
  userId: 'user-123',
  agentId: 'agent-456',
  proxyEndpoints: {
    'weather-mcp': 'https://weather-proxy.example.com',
    'finance-mcp': 'https://finance-proxy.example.com',
  },
});
```

### Error Handling

```typescript
import {
  InvalidTokenException,
  IntentMismatchException,
  MCPInvocationException,
  TokenExpiredException,
} from '@armoriq/sdk';

try {
  const result = await client.invoke('weather-mcp', 'get_weather', token, { city: 'Boston' });
} catch (error) {
  if (error instanceof TokenExpiredException) {
    console.error('Token expired, please get a new one');
  } else if (error instanceof IntentMismatchException) {
    console.error('Action not in original plan');
  } else if (error instanceof MCPInvocationException) {
    console.error('MCP invocation failed:', error.message);
  }
}
```

---

## API Reference

### `ArmorIQClient`

#### Constructor Options

```typescript
interface SDKConfig {
  apiKey: string; // Required: Your API key
  userId: string; // Required: User identifier
  agentId: string; // Required: Agent identifier
  contextId?: string; // Optional: Context identifier (default: 'default')
  useProduction?: boolean; // Optional: Use production endpoints (default: true)
  iapEndpoint?: string; // Optional: Override IAP endpoint
  proxyEndpoint?: string; // Optional: Override proxy endpoint
  backendEndpoint?: string; // Optional: Override backend endpoint
  proxyEndpoints?: Record<string, string>; // Optional: MCP-specific proxies
  timeout?: number; // Optional: Request timeout in ms (default: 30000)
  maxRetries?: number; // Optional: Max retry attempts (default: 3)
  verifySsl?: boolean; // Optional: Verify SSL (default: true)
}
```

#### Methods

- `capturePlan(llm, prompt, plan, metadata?)` - Capture an execution plan
- `getIntentToken(planCapture, policy?, validitySeconds?)` - Get a signed intent token
- `invoke(mcp, action, intentToken, params?, merkleProof?, userEmail?)` - Invoke an MCP action
- `delegate(intentToken, delegatePublicKey, validitySeconds?, allowedActions?, targetAgent?, subtask?)` - Delegate to another agent
- `verifyToken(intentToken)` - Verify a token locally
- `close()` - Cleanup resources

---

## Documentation

For complete documentation, visit [docs.armoriq.ai](https://docs.armoriq.ai)

---

## Links

- [armoriq.ai](https://armoriq.ai)
- [docs.armoriq.ai](https://docs.armoriq.ai)
- [platform.armoriq.ai](https://platform.armoriq.ai)

---

## License

MIT License - see [LICENSE](LICENSE) file for details.
