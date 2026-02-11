#!/usr/bin/env npx tsx
/**
 * Reusable script: find OpenTable availability for a restaurant, date, and party size.
 * Usage:
 *   Live:  npx tsx get-availability.ts <restaurantUrl> <date> <partySize> [--no-headless] [--json]
 *   HAR:   npx tsx get-availability.ts --har <path> [--date YYYY-MM-DD] [--party N] [--json]
 */

import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const GQL_URL =
  'https://www.opentable.com/dapi/fe/gql?optype=query&opname=RestaurantsAvailability';
const CAPTURE_TIMEOUT_MS = 30_000;

// --- CLI ---
function parseArgs(): {
  mode: 'live' | 'har';
  url?: string;
  date: string;
  partySize: number;
  headless: boolean;
  json: boolean;
  harPath?: string;
} {
  const args = process.argv.slice(2);
  const harIdx = args.indexOf('--har');
  const harPath = harIdx >= 0 ? args[harIdx + 1] : undefined;
  const hasHar = harIdx >= 0 && harPath;

  const dateIdx = args.indexOf('--date');
  const dateArg = dateIdx >= 0 ? args[dateIdx + 1] : undefined;
  const partyIdx = args.indexOf('--party');
  const partyArg = partyIdx >= 0 ? args[partyIdx + 1] : undefined;

  const headless = !args.includes('--no-headless');
  const json = args.includes('--json');

  const positionals = args.filter(
    (a, i) =>
      !a.startsWith('--') &&
      a !== harPath &&
      a !== dateArg &&
      a !== partyArg &&
      (a !== '--har' || i !== harIdx) &&
      (a !== '--date' || i !== dateIdx) &&
      (a !== '--party' || i !== partyIdx)
  );

  if (hasHar) {
    return {
      mode: 'har',
      date: dateArg ?? '',
      partySize: partyArg ? parseInt(partyArg, 10) : 0,
      headless: true,
      json,
      harPath,
    };
  }

  if (positionals.length < 3) {
    console.error(
      'Usage (live): get-availability.ts <restaurantUrl> <date YYYY-MM-DD> <partySize> [--no-headless] [--json]'
    );
    console.error(
      'Usage (HAR):  get-availability.ts --har <path> [--date YYYY-MM-DD] [--party N] [--json]'
    );
    process.exit(1);
  }

  return {
    mode: 'live',
    url: positionals[0],
    date: positionals[1],
    partySize: parseInt(positionals[2], 10),
    headless,
    json,
  };
}

// --- Time conversion: base time (e.g. "19:00") + offset minutes => "HH:MM" ---
function offsetToTime(baseTime: string, timeOffsetMinutes: number): string {
  const [h, m] = baseTime.split(':').map(Number);
  const totalMinutes = h * 60 + m + timeOffsetMinutes;
  const wrapped = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = Math.floor(wrapped / 60);
  const mm = wrapped % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// --- Response shape (minimal) ---
interface AvailabilitySlot {
  isAvailable?: boolean;
  timeOffsetMinutes?: number;
  type?: string;
  __typename?: string;
}

interface AvailabilityDay {
  dayOffset: number;
  topExperience?: { name?: string };
  slots: AvailabilitySlot[];
}

interface AvailabilityResponse {
  data?: {
    availability?: Array<{
      restaurantId?: number;
      availabilityDays?: AvailabilityDay[];
    }>;
  };
}

// --- Extract available slots for requested date (dayOffset 0) ---
function extractSlots(
  res: AvailabilityResponse,
  baseTime: string,
  requestedDate: string
): Array<{ time: string; type: string }> {
  const days =
    res.data?.availability?.[0]?.availabilityDays ?? [];
  const day0 = days.find((d) => d.dayOffset === 0) ?? days[0];
  if (!day0?.slots) return [];

  const slots: Array<{ time: string; type: string }> = [];
  for (const slot of day0.slots) {
    if (slot.isAvailable && typeof slot.timeOffsetMinutes === 'number') {
      const time = offsetToTime(baseTime, slot.timeOffsetMinutes);
      const type = slot.type ?? 'Standard';
      slots.push({ time, type });
    }
  }
  return slots;
}

// --- Print table or JSON ---
function printResult(
  slots: Array<{ time: string; type: string }>,
  date: string,
  json: boolean
): void {
  if (json) {
    console.log(JSON.stringify({ date, slots }, null, 2));
    return;
  }
  if (slots.length === 0) {
    console.log(`No available slots for ${date}.`);
    return;
  }
  console.log(`Availability for ${date}:`);
  console.log('Time   \tType');
  console.log('-------\t----------');
  for (const { time, type } of slots) {
    console.log(`${time}\t${type}`);
  }
  console.log(`(${slots.length} slot(s))`);
}

// --- HAR mode: read file, find RestaurantsAvailability entries, parse and print ---
function runHarMode(
  harPath: string,
  filterDate: string,
  filterParty: number,
  json: boolean
): void {
  const har = JSON.parse(readFileSync(harPath, 'utf8'));
  const entries = har.log?.entries ?? [];
  const matches = entries.filter(
    (e: { request?: { url?: string; method?: string; postData?: { text?: string } }; response?: { content?: { text?: string } } }) => {
      if (e.request?.method !== 'POST') return false;
      if (!e.request.url?.includes('RestaurantsAvailability')) return false;
      if (!e.response?.content?.text) return false;
      if (filterDate && e.request.postData?.text && !e.request.postData.text.includes(`"date":"${filterDate}"`))
        return false;
      if (filterParty > 0 && e.request.postData?.text && !e.request.postData.text.includes(`"partySize":${filterParty}`))
        return false;
      return true;
    }
  );

  if (matches.length === 0) {
    console.error('No matching RestaurantsAvailability entries in HAR.');
    process.exit(1);
  }

  let baseTime = '19:00';
  for (const entry of matches) {
    try {
      const body = entry.request?.postData?.text;
      if (body) {
        const parsed = JSON.parse(body);
        if (parsed.variables?.time) baseTime = parsed.variables.time;
      }
    } catch {
      // keep default baseTime
    }
    const text = entry.response?.content?.text;
    if (!text) continue;
    try {
      const res: AvailabilityResponse = JSON.parse(text);
      const requestedDate =
        filterDate ||
        (() => {
          try {
            const b = entry.request?.postData?.text;
            if (b) {
              const p = JSON.parse(b);
              return p.variables?.date ?? '';
            }
          } catch {
            //
          }
          return '';
        })();
      const slots = extractSlots(res, baseTime, requestedDate);
      printResult(slots, requestedDate || 'date-unknown', json);
      if (filterDate || filterParty) break; // one match enough when filtering
    } catch (err) {
      console.error('Failed to parse HAR response:', err);
    }
  }
}

// --- Live mode: Playwright + capture first request, then POST with new date/party (same context) ---
async function runLiveMode(
  url: string,
  date: string,
  partySize: number,
  headless: boolean,
  json: boolean
): Promise<void> {
  let capturedBody: string | null = null;
  let capturedHeaders: Record<string, string> = {};
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ headless });
  } catch (err) {
    if (String(err).includes("Executable doesn't exist")) {
      try {
        browser = await chromium.launch({ headless, channel: 'chrome' });
      } catch {
        throw err;
      }
    } else {
      throw err;
    }
  }
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    const capturePromise = new Promise<{ body: string; headers: Record<string, string> }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout waiting for RestaurantsAvailability request')), CAPTURE_TIMEOUT_MS);
      page.on('request', async (req) => {
        if (req.method() !== 'POST') return;
        if (!req.url().includes('RestaurantsAvailability')) return;
        const postData = req.postData();
        if (!postData) return;
        clearTimeout(t);
        const raw = req.headers();
        const headersObj: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) {
          const lower = k.toLowerCase();
          if (lower === 'content-type' || lower === 'x-csrf-token' || lower === 'origin' || lower === 'referer' || lower === 'ot-page-group' || lower === 'ot-page-type') {
            headersObj[k] = v;
          }
        }
        resolve({ body: postData, headers: headersObj });
      });
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {
      // some sites never reach networkidle; continue
    });

    const captured = await capturePromise;
    capturedBody = captured.body;
    capturedHeaders = captured.headers;
  } catch (err) {
    await browser.close();
    throw err;
  }

  if (!capturedBody) {
    await browser.close();
    console.error('Could not capture RestaurantsAvailability request.');
    process.exit(1);
  }

  let body: {
    operationName: string;
    variables: Record<string, unknown>;
    extensions: { persistedQuery: { version: number; sha256Hash: string } };
  };
  try {
    body = JSON.parse(capturedBody);
  } catch {
    await browser.close();
    console.error('Invalid captured request body.');
    process.exit(1);
  }

  body.variables = {
    ...body.variables,
    date,
    partySize,
    // Request a full day of slots (same as UI when viewing full availability)
    forwardMinutes: 295,
    backwardMinutes: 1140,
    forwardTimeslots: 20,
    backwardTimeslots: 76,
  };
  const requestBody = JSON.stringify(body);

  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    if (!page) {
      console.error('No page in context.');
      await browser.close();
      process.exit(1);
    }

    const response = await page.request.post(GQL_URL, {
      data: requestBody,
      headers: {
        ...capturedHeaders,
        'Content-Type': 'application/json',
        origin: 'https://www.opentable.com',
        referer: url,
      },
    });

    if (!response.ok()) {
      console.error('API request failed:', response.status(), await response.text());
      await browser.close();
      process.exit(1);
    }

    const resText = await response.text();
    let res: AvailabilityResponse;
    try {
      res = JSON.parse(resText);
    } catch {
      console.error('Invalid API response.');
      await browser.close();
      process.exit(1);
    }

    const baseTime = (body.variables.time as string) ?? '19:00';
    const slots = extractSlots(res, baseTime, date);
    printResult(slots, date, json);
  } finally {
    await browser.close();
  }
}

// --- Main ---
async function main(): Promise<void> {
  const opts = parseArgs();
  if (opts.mode === 'har') {
    if (!opts.harPath) {
      console.error('--har requires a path.');
      process.exit(1);
    }
    runHarMode(opts.harPath, opts.date, opts.partySize, opts.json);
    return;
  }
  await runLiveMode(
    opts.url!,
    opts.date,
    opts.partySize,
    opts.headless,
    opts.json
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
