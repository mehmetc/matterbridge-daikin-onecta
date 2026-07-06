/**
 * Tests for the Matter-change → Onecta-PATCH planners, using state parsed
 * from the anonymized fixture of real dx4 units.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { FanControl, Thermostat } from 'matterbridge/matter/clusters';

import { parseClimateStates, type ClimateState } from '../src/mapper.js';
import { applyWriteToState, clampSetpoint, planFanModeChange, planFanPercentChange, planPowerfulChange, planSetpointChange, planSystemModeChange } from '../src/writes.js';

const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'gateway-devices.json'), 'utf8')) as Record<string, unknown>[];

/** Fresh state of unit 1: off, cooling mode, cooling setpoint 25 (18..33 step 0.5), fan auto (speed 1, max 5). */
const freshState = (): ClimateState => parseClimateStates(fixture[0])[0];

describe('planSystemModeChange', () => {
  test('should turn the unit off when it is on', () => {
    const state = { ...freshState(), onOff: true };
    expect(planSystemModeChange(state, Thermostat.SystemMode.Off)).toEqual([{ dataPoint: 'onOffMode', path: null, value: 'off' }]);
  });

  test('should do nothing when turning off an already-off unit', () => {
    expect(planSystemModeChange(freshState(), Thermostat.SystemMode.Off)).toEqual([]);
  });

  test('should switch mode and turn on an off unit', () => {
    expect(planSystemModeChange(freshState(), Thermostat.SystemMode.Heat)).toEqual([
      { dataPoint: 'operationMode', path: null, value: 'heating' },
      { dataPoint: 'onOffMode', path: null, value: 'on' },
    ]);
  });

  test('should only turn on when the mode already matches', () => {
    expect(planSystemModeChange(freshState(), Thermostat.SystemMode.Cool)).toEqual([{ dataPoint: 'onOffMode', path: null, value: 'on' }]);
  });

  test('should do nothing when mode and power already match', () => {
    const state = { ...freshState(), onOff: true };
    expect(planSystemModeChange(state, Thermostat.SystemMode.Cool)).toEqual([]);
  });

  test('should ignore unsupported system modes', () => {
    expect(planSystemModeChange(freshState(), Thermostat.SystemMode.Sleep)).toEqual([]);
    const noDry = { ...freshState(), supportedModes: ['heating', 'cooling'] as ClimateState['supportedModes'] };
    expect(planSystemModeChange(noDry, Thermostat.SystemMode.Dry)).toEqual([]);
  });
});

describe('clampSetpoint', () => {
  const range = { value: 25, min: 18, max: 33, step: 0.5 };

  test('should round to the device step', () => {
    expect(clampSetpoint(22.3, range)).toBe(22.5);
    expect(clampSetpoint(22.2, range)).toBe(22);
  });

  test('should clamp into the allowed range', () => {
    expect(clampSetpoint(5, range)).toBe(18);
    expect(clampSetpoint(40, range)).toBe(33);
  });
});

describe('planSetpointChange', () => {
  test('should write the cooling setpoint of the cooling mode', () => {
    expect(planSetpointChange(freshState(), 'cooling', 24)).toEqual([{ dataPoint: 'temperatureControl', path: '/operationModes/cooling/setpoints/roomTemperature', value: 24 }]);
  });

  test('should do nothing when the value already matches', () => {
    expect(planSetpointChange(freshState(), 'cooling', 25)).toEqual([]);
  });

  test('should target the auto setpoint when the unit runs in auto mode', () => {
    const state = { ...freshState(), operationMode: 'auto' as const };
    expect(planSetpointChange(state, 'cooling', 24)).toEqual([{ dataPoint: 'temperatureControl', path: '/operationModes/auto/setpoints/roomTemperature', value: 24 }]);
    expect(planSetpointChange(state, 'heating', 21)).toEqual([]);
  });

  test('should do nothing without a setpoint range', () => {
    const state = { ...freshState(), coolingSetpoint: undefined, autoSetpoint: undefined };
    expect(planSetpointChange(state, 'cooling', 24)).toEqual([]);
  });
});

describe('planFanPercentChange', () => {
  test('should switch to fixed speed for a percentage', () => {
    expect(planFanPercentChange(freshState(), 60)).toEqual([
      { dataPoint: 'fanControl', path: '/operationModes/cooling/fanSpeed/currentMode', value: 'fixed' },
      { dataPoint: 'fanControl', path: '/operationModes/cooling/fanSpeed/modes/fixed', value: 3 },
    ]);
  });

  test('should only change speed when already in fixed mode', () => {
    const state = freshState();
    state.fan = { mode: 'fixed', speed: 3, maxSpeed: 5 };
    expect(planFanPercentChange(state, 100)).toEqual([{ dataPoint: 'fanControl', path: '/operationModes/cooling/fanSpeed/modes/fixed', value: 5 }]);
    expect(planFanPercentChange(state, 60)).toEqual([]);
  });

  test('should switch to auto at 0 percent', () => {
    const state = freshState();
    state.fan = { mode: 'fixed', speed: 3, maxSpeed: 5 };
    expect(planFanPercentChange(state, 0)).toEqual([{ dataPoint: 'fanControl', path: '/operationModes/cooling/fanSpeed/currentMode', value: 'auto' }]);
    expect(planFanPercentChange(freshState(), 0)).toEqual([]);
  });

  test('should do nothing for null or without fan data', () => {
    expect(planFanPercentChange(freshState(), null)).toEqual([]);
    expect(planFanPercentChange({ ...freshState(), fan: undefined }, 50)).toEqual([]);
  });
});

describe('planFanModeChange', () => {
  test('should map Auto and Low (quiet)', () => {
    const state = freshState();
    state.fan = { mode: 'fixed', speed: 3, maxSpeed: 5 };
    expect(planFanModeChange(state, FanControl.FanMode.Auto)).toEqual([{ dataPoint: 'fanControl', path: '/operationModes/cooling/fanSpeed/currentMode', value: 'auto' }]);
    expect(planFanModeChange(state, FanControl.FanMode.Low)).toEqual([{ dataPoint: 'fanControl', path: '/operationModes/cooling/fanSpeed/currentMode', value: 'quiet' }]);
    expect(planFanModeChange(freshState(), FanControl.FanMode.Auto)).toEqual([]);
  });

  test('should map Medium and High to fixed speeds', () => {
    expect(planFanModeChange(freshState(), FanControl.FanMode.High)).toEqual([
      { dataPoint: 'fanControl', path: '/operationModes/cooling/fanSpeed/currentMode', value: 'fixed' },
      { dataPoint: 'fanControl', path: '/operationModes/cooling/fanSpeed/modes/fixed', value: 5 },
    ]);
    expect(planFanModeChange(freshState(), FanControl.FanMode.Medium)[1]).toEqual({ dataPoint: 'fanControl', path: '/operationModes/cooling/fanSpeed/modes/fixed', value: 3 });
  });

  test('should ignore Off and On', () => {
    expect(planFanModeChange(freshState(), FanControl.FanMode.Off)).toEqual([]);
  });
});

describe('planPowerfulChange', () => {
  test('should toggle powerful mode', () => {
    expect(planPowerfulChange(freshState(), true)).toEqual([{ dataPoint: 'powerfulMode', path: null, value: 'on' }]);
    expect(planPowerfulChange(freshState(), false)).toEqual([]);
    expect(planPowerfulChange({ ...freshState(), powerful: undefined }, true)).toEqual([]);
  });
});

describe('applyWriteToState', () => {
  test('should apply power, mode, setpoint and fan writes', () => {
    const state = freshState();
    applyWriteToState(state, { dataPoint: 'onOffMode', path: null, value: 'on' });
    expect(state.onOff).toBe(true);
    applyWriteToState(state, { dataPoint: 'operationMode', path: null, value: 'heating' });
    expect(state.operationMode).toBe('heating');
    applyWriteToState(state, { dataPoint: 'powerfulMode', path: null, value: 'on' });
    expect(state.powerful).toBe(true);
    applyWriteToState(state, { dataPoint: 'temperatureControl', path: '/operationModes/cooling/setpoints/roomTemperature', value: 24 });
    expect(state.coolingSetpoint?.value).toBe(24);
    applyWriteToState(state, { dataPoint: 'fanControl', path: '/operationModes/cooling/fanSpeed/currentMode', value: 'fixed' });
    expect(state.fan?.mode).toBe('fixed');
    applyWriteToState(state, { dataPoint: 'fanControl', path: '/operationModes/cooling/fanSpeed/modes/fixed', value: 4 });
    expect(state.fan?.speed).toBe(4);
  });

  test('should ignore unknown writes', () => {
    const state = freshState();
    applyWriteToState(state, { dataPoint: 'schedule', path: null, value: 'x' });
    applyWriteToState(state, { dataPoint: 'temperatureControl', path: '/operationModes/bogus/setpoints/roomTemperature', value: 24 });
    expect(state).toEqual(freshState());
  });
});
