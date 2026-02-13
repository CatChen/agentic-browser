import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const OUT_DIR = 'out';

/** Absolute path to out so the Playwright MCP (subprocess) writes all artifacts here. */
const OUT_DIR_ABS = path.join(process.cwd(), OUT_DIR);

function clearOutDir(): void {
  if (fs.existsSync(OUT_DIR)) {
    fs.rmSync(OUT_DIR, { recursive: true });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function summarizeMessage(msg: SDKMessage, turnRef: { current: number }): void {
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        console.log('[Session] Started with Playwright MCP.');
      }
      break;
    case 'assistant': {
      turnRef.current += 1;
      const content = msg.message.content;
      if (!content?.length) break;
      const textParts: string[] = [];
      const toolNames: string[] = [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        }
        if (block.type === 'tool_use') {
          toolNames.push((block as { name?: string }).name ?? 'tool');
        }
      }
      if (toolNames.length) {
        console.log(`Turn ${turnRef.current}: Used ${toolNames.join(', ')}.`);
      }
      if (textParts.length) {
        console.log(`Turn ${turnRef.current}: ${textParts[0]}`);
      }
      break;
    }
    case 'tool_progress':
      console.log(`  → ${msg.tool_name} (${msg.elapsed_time_seconds}s)`);
      break;
    case 'result': {
      if (msg.subtype === 'success') {
        console.log(`\n[Done] ${msg.num_turns} turns, ${(msg.duration_ms / 1000).toFixed(1)}s.`);
        if (msg.result) {
          const firstLine = msg.result.split('\n')[0].slice(0, 100);
          console.log(`Result: ${firstLine}${msg.result.length > 100 ? '…' : ''}`);
        }
      } else {
        console.log(`\n[Ended] ${msg.subtype}: ${msg.errors?.join('; ') ?? '—'}`);
      }
      break;
    }
    default:
      break;
  }
}

function listOutDir(): void {
  const entries = fs.readdirSync(OUT_DIR, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  console.log('\n--- Captured in out/ ---');
  for (const d of dirs.sort()) {
    console.log(`  ${OUT_DIR}/${d}/`);
  }
  const describe = (name: string): string => {
    if (name.startsWith('console-') && name.endsWith('.log')) return ' — browser console (errors/warnings)';
    return '';
  };
  for (const f of files.sort()) {
    const stat = fs.statSync(`${OUT_DIR}/${f}`);
    const size = stat.size;
    const sizeStr = size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
    console.log(`  ${OUT_DIR}/${f} (${sizeStr})${describe(f)}`);
  }
}

async function main(): Promise<void> {
  clearOutDir();

  const userPrompt = await promptUser('Enter your prompt: ');
  if (!userPrompt) {
    console.log('No prompt entered. Exiting.');
    process.exit(1);
  }

  const result: Query = query({
    prompt: userPrompt,
    options: {
      mcpServers: {
        playwright: {
          command: 'npx',
          args: [
            '@playwright/mcp@latest',
            '--config',
            'playwright-mcp-config.json',
            '--output-dir',
            OUT_DIR_ABS,
          ],
        },
      },
      allowedTools: ['mcp__playwright__*'],
      permissionMode: 'bypassPermissions',
    },
  });

  const turnRef = { current: 0 };
  for await (const message of result) {
    summarizeMessage(message, turnRef);
  }

  listOutDir();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
