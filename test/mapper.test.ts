/**
 * Tests for the Onecta → typed state mapper, using the anonymized fixture
 * captured from four real dx4 split AC units.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { endpointSerial, parseClimateStates, toFanPercent, toMatterTemperature } from '../src/mapper.js';

const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'gateway-devices.json'), 'utf8')) as Record<string, unknown>[];

describe('parseClimateStates', () => {
  test('should parse one climate state per dx4 gateway device', () => {
    const states = fixture.flatMap((desc) => parseClimateStates(desc));
    expect(states).toHaveLength(4);
    expect(states.map((s) => s.name)).toEqual(['Room 1', 'Room 2', 'Room 3', 'Room 4']);
  });

  test('should parse the full state of the first unit', () => {
    const [state] = parseClimateStates(fixture[0]);
    expect(state.gatewayId).toBe('00000000-0000-4000-8000-000000000001');
    expect(state.embeddedId).toBe('climateControl');
    expect(state.connected).toBe(true);
    expect(state.onOff).toBe(false);
    expect(state.operationMode).toBe('cooling');
    expect(state.supportedModes).toEqual(['heating', 'cooling', 'auto', 'dry', 'fanOnly']);
    expect(state.roomTemperature).toBe(23);
    expect(state.outdoorTemperature).toBe(23.5);
    expect(state.coolingSetpoint).toEqual({ value: 25, min: 18, max: 33, step: 0.5 });
    expect(state.heatingSetpoint).toMatchObject({ min: 10, max: 31 });
    expect(state.autoSetpoint).toMatchObject({ min: 18, max: 30 });
    expect(state.fan).toEqual({ mode: 'auto', speed: 1, maxSpeed: 5 });
  });

  test('should return an empty list for devices without climateControl', () => {
    expect(parseClimateStates({ id: 'x', managementPoints: [{ managementPointType: 'gateway' }] })).toEqual([]);
    expect(parseClimateStates({})).toEqual([]);
  });

  test('should survive missing optional characteristics', () => {
    const [state] = parseClimateStates({
      id: 'gw-min',
      managementPoints: [{ managementPointType: 'climateControl', embeddedId: 'cc' }],
    });
    expect(state.name).toBe('gw-min');
    expect(state.onOff).toBe(false);
    expect(state.roomTemperature).toBeUndefined();
    expect(state.heatingSetpoint).toBeUndefined();
    expect(state.fan).toBeUndefined();
  });
});

describe('endpointSerial', () => {
  test('should build stable serials within the 32 char Matter limit', () => {
    const serial = endpointSerial('00000000-0000-4000-8000-000000000001', 'CC');
    expect(serial).toBe('000000000000400080000000-CC');
    expect(serial.length).toBeLessThanOrEqual(32);
    expect(endpointSerial('00000000-0000-4000-8000-000000000001', 'FAN').length).toBeLessThanOrEqual(32);
  });
});

describe('temperature and fan conversions', () => {
  test('should convert to Matter centi-degrees', () => {
    expect(toMatterTemperature(23.5)).toBe(2350);
    expect(toMatterTemperature(-5)).toBe(-500);
  });

  test('should convert fixed fan speeds to percent', () => {
    expect(toFanPercent(1, 5)).toBe(20);
    expect(toFanPercent(5, 5)).toBe(100);
    expect(toFanPercent(3, 5)).toBe(60);
    expect(toFanPercent(7, 5)).toBe(100);
    expect(toFanPercent(0, 5)).toBe(1);
  });
});
