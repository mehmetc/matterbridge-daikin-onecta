import { describe, expect, test } from 'vitest';
/**
 * Tests for the pure helper functions.
 */

import { formatDeviceTree, isDaytime, parseHHMM, pollDelayMs, type DeviceLike } from '../src/utils.js';

describe('parseHHMM', () => {
  test('should parse a valid HH:MM string', () => {
    expect(parseHHMM('07:00', 0)).toBe(7 * 60);
    expect(parseHHMM('22:30', 0)).toBe(22 * 60 + 30);
    expect(parseHHMM('0:05', 0)).toBe(5);
  });

  test('should return the fallback when malformed', () => {
    expect(parseHHMM('7', 123)).toBe(123);
    expect(parseHHMM('', 123)).toBe(123);
    expect(parseHHMM(undefined, 123)).toBe(123);
    expect(parseHHMM('25:00', 123)).toBe(123);
    expect(parseHHMM('12:75', 123)).toBe(123);
  });
});

describe('isDaytime', () => {
  const at = (hours: number, minutes = 0): Date => new Date(2026, 6, 6, hours, minutes);

  test('should detect day and night for a normal window', () => {
    expect(isDaytime('07:00', '22:00', at(12))).toBe(true);
    expect(isDaytime('07:00', '22:00', at(7))).toBe(true);
    expect(isDaytime('07:00', '22:00', at(22))).toBe(false);
    expect(isDaytime('07:00', '22:00', at(3))).toBe(false);
  });

  test('should support windows crossing midnight', () => {
    expect(isDaytime('22:00', '06:00', at(23))).toBe(true);
    expect(isDaytime('22:00', '06:00', at(3))).toBe(true);
    expect(isDaytime('22:00', '06:00', at(12))).toBe(false);
  });

  test('should fall back to 07:00-22:00 when unparsable', () => {
    expect(isDaytime(undefined, undefined, at(12))).toBe(true);
    expect(isDaytime('bogus', 'bogus', at(23))).toBe(false);
  });
});

describe('pollDelayMs', () => {
  const config = { pollingIntervalDay: 10, pollingIntervalNight: 30, dayStart: '07:00', dayEnd: '22:00' };

  test('should use the day interval during the day window', () => {
    expect(pollDelayMs(config, new Date(2026, 6, 6, 12, 0))).toBe(10 * 60_000);
  });

  test('should use the night interval outside the day window', () => {
    expect(pollDelayMs(config, new Date(2026, 6, 6, 23, 0))).toBe(30 * 60_000);
  });

  test('should clamp to a minimum of 1 minute and survive bad values', () => {
    expect(pollDelayMs({ ...config, pollingIntervalDay: 0 }, new Date(2026, 6, 6, 12, 0))).toBe(10 * 60_000);
    expect(pollDelayMs({ ...config, pollingIntervalDay: 0.5 }, new Date(2026, 6, 6, 12, 0))).toBe(60_000);
  });
});

describe('formatDeviceTree', () => {
  const device: DeviceLike = {
    getId: () => 'gw-1',
    isCloudConnectionUp: () => true,
    getDescription: () => ({
      deviceModel: 'Altherma',
      managementPoints: [
        {
          embeddedId: 'gateway',
          managementPointType: 'gateway',
          modelInfo: { value: 'BRP069C4x' },
        },
        {
          embeddedId: 'climateControl',
          managementPointType: 'climateControl',
          name: { value: 'Living room' },
          onOffMode: { value: 'on' },
          operationMode: { value: 'cooling' },
          sensoryData: { value: { roomTemperature: { value: 24.5 }, outdoorTemperature: { value: 31 } } },
        },
      ],
    }),
  };

  test('should render gateway devices with management points, characteristics and state', () => {
    const lines = formatDeviceTree([device]);
    expect(lines[0]).toBe('Gateway device gw-1 (model: Altherma, connected: true)');
    expect(lines).toContainEqual(expect.stringContaining('[gateway] gateway model=BRP069C4x'));
    expect(lines).toContainEqual(expect.stringContaining('[climateControl] climateControl name="Living room"'));
    expect(lines).toContainEqual(expect.stringContaining('characteristics: name, onOffMode, operationMode, sensoryData'));
    expect(lines).toContainEqual(expect.stringContaining('state: onOffMode=on, operationMode=cooling, roomTemperature=24.5, outdoorTemperature=31'));
  });

  test('should handle devices without management points', () => {
    const bare: DeviceLike = { getId: () => 'gw-2', isCloudConnectionUp: () => false, getDescription: () => ({}) };
    expect(formatDeviceTree([bare])).toEqual(['Gateway device gw-2 (model: unknown, connected: false)']);
  });
});
