/**
 * Pure helper functions for the Daikin Onecta plugin.
 *
 * @file utils.ts
 * @author Mehmet Celik
 * @license Apache-2.0
 */

export interface PollingConfig {
  pollingIntervalDay: number;
  pollingIntervalNight: number;
  dayStart: string;
  dayEnd: string;
}

/**
 * Parse a "HH:MM" string to minutes since midnight, falling back when malformed.
 *
 * @param {string | undefined} value - The "HH:MM" string.
 * @param {number} fallbackMinutes - Returned when the string is missing or malformed.
 * @returns {number} Minutes since midnight.
 */
export function parseHHMM(value: string | undefined, fallbackMinutes: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value?.trim() ?? '');
  if (!match) return fallbackMinutes;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallbackMinutes;
  return hours * 60 + minutes;
}

/**
 * True when `now` falls inside the configured day window (supports windows crossing midnight).
 *
 * @param {string | undefined} dayStart - Window start as "HH:MM" (default 07:00).
 * @param {string | undefined} dayEnd - Window end as "HH:MM" (default 22:00).
 * @param {Date} now - The time to test.
 * @returns {boolean} Whether `now` is inside the day window.
 */
export function isDaytime(dayStart: string | undefined, dayEnd: string | undefined, now: Date): boolean {
  const start = parseHHMM(dayStart, 7 * 60);
  const end = parseHHMM(dayEnd, 22 * 60);
  const current = now.getHours() * 60 + now.getMinutes();
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

/**
 * Delay until the next poll, respecting the day/night polling intervals. Minimum 1 minute.
 *
 * @param {PollingConfig} config - The polling configuration.
 * @param {Date} now - The current time (injectable for tests).
 * @returns {number} The delay in milliseconds.
 */
export function pollDelayMs(config: PollingConfig, now: Date = new Date()): number {
  const minutes = isDaytime(config.dayStart, config.dayEnd, now) ? config.pollingIntervalDay : config.pollingIntervalNight;
  return Math.max(1, minutes || 10) * 60_000;
}

/** Minimal shape of a daikin-controller-cloud device used for logging. */
export interface DeviceLike {
  getId(): string;
  getDescription(): Record<string, unknown>;
  isCloudConnectionUp(): boolean;
}

interface ManagementPointLike {
  embeddedId?: string;
  managementPointType?: string;
  [characteristic: string]: unknown;
}

const value = (data: unknown): unknown => (data && typeof data === 'object' && 'value' in data ? data.value : undefined);

const asString = (data: unknown): string => (data !== null && typeof data === 'object' ? JSON.stringify(data) : String(data));

/**
 * Render the discovered gateway devices as indented log lines.
 *
 * @param {DeviceLike[]} devices - The devices returned by daikin-controller-cloud.
 * @returns {string[]} The log lines.
 */
export function formatDeviceTree(devices: DeviceLike[]): string[] {
  const lines: string[] = [];
  for (const device of devices) {
    const desc = device.getDescription();
    lines.push(`Gateway device ${device.getId()} (model: ${asString(desc.deviceModel ?? 'unknown')}, connected: ${device.isCloudConnectionUp()})`);
    const managementPoints = Array.isArray(desc.managementPoints)
      ? desc.managementPoints.filter((point): point is ManagementPointLike => point !== null && typeof point === 'object')
      : [];
    for (const point of managementPoints) {
      const name = value(point.name);
      const model = value(point.modelInfo);
      const header = [`[${point.managementPointType ?? 'unknown'}] ${point.embeddedId ?? '?'}`];
      if (name) header.push(`name="${asString(name)}"`);
      if (model) header.push(`model=${asString(model)}`);
      lines.push(`  ${header.join(' ')}`);
      const characteristics = Object.keys(point)
        .filter((key) => !['embeddedId', 'managementPointType'].includes(key))
        .toSorted();
      if (characteristics.length > 0) {
        lines.push(`    characteristics: ${characteristics.join(', ')}`);
      }
      const onOff = value(point.onOffMode);
      const mode = value(point.operationMode);
      const sensors = value(point.sensoryData);
      const state: string[] = [];
      if (onOff !== undefined) state.push(`onOffMode=${asString(onOff)}`);
      if (mode !== undefined) state.push(`operationMode=${asString(mode)}`);
      if (sensors && typeof sensors === 'object') {
        for (const [sensor, data] of Object.entries(sensors)) {
          const sensorValue = value(data);
          if (sensorValue !== undefined) state.push(`${sensor}=${asString(sensorValue)}`);
        }
      }
      if (state.length > 0) {
        lines.push(`    state: ${state.join(', ')}`);
      }
    }
  }
  return lines;
}
