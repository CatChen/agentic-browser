import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

const result: Query = query({
  prompt:
    'Open a browser and navigate to ' +
    'https://www.opentable.com/cascal?originId=86a46ae2-ddd7-4baf-a132-94916a049ac5&corrid=86a46ae2-ddd7-4baf-a132-94916a049ac5&avt=eyJ2IjoyLCJtIjoxLCJwIjowLCJzIjowLCJuIjowfQ. ' +
    'Find availabilities for 02/26/2026 for 4 people.',
  options: {
    mcpServers: {
      playwright: {
        command: 'npx',
        args: [
          '@playwright/mcp@latest',
          '--config',
          'playwright-mcp-config.json',
        ],
      },
    },
    allowedTools: ['mcp__playwright__*'],
    permissionMode: 'bypassPermissions',
  },
});

for await (const message of result) {
  console.log(`***************** ${message.type} *****************`);
  switch (message.type) {
    case 'assistant':
      for (const content of message.message.content) {
        if (content.type === 'text') {
          console.log(content.text);
        } else {
          console.log(content.type);
          console.log(content);
        }
      }
      break;
    case 'user':
      for (const content of message.message.content) {
        console.log(content.type);
        console.log(content.content);
      }
      break;
    default:
      console.log(message);
      break;
  }
}
