import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

const result: Query = query({
  prompt: 'Open a browser and navigate to example.com',
  options: {
    mcpServers: {
      playwright: {
        command: 'npx',
        args: ['-y', '@executeautomation/playwright-mcp-server'],
      },
    },
    allowedTools: ['mcp__playwright__*'],
    permissionMode: 'bypassPermissions',
  },
});

for await (const message of result) {
  switch (message.type) {
    case 'assistant':
      for (const content of message.message.content) {
        if (content.type === 'text') {
          console.log(content.text);
        }
      }
  }
}
