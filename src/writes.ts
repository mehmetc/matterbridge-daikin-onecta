/**
 * Pure planners that translate Matter attribute changes into Onecta PATCH commands,
 * and apply successful commands optimistically to the cached climate state.
 * No network or Matter server dependencies: fully unit-testable.
 *
 * @file writes.ts
 * @author Mehmet Celik
 * @license Apache-2.0
 */

import { FanControl, Thermostat } from 'matterbridge/matter/clusters';

import type { ClimateState, OnectaOperationMode, SetpointRange } from './mapper.js';

/** One PATCH to a management point characteristic. */
export interface WriteCommand {
  dataPoint: string;
  /** Sub-path inside the characteristic, e.g. "/operationModes/cooling/setpoints/roomTemperature", or null for simple characteristics. */
  path: string | null;
  value: string | number;
}

const MODE_BY_SYSTEM_MODE = new Map<Thermostat.SystemMode, OnectaOperationMode>([
  [Thermostat.SystemMode.Heat, 'heating'],
  [Thermostat.SystemMode.Cool, 'cooling'],
  [Thermostat.SystemMode.Auto, 'auto'],
  [Thermostat.SystemMode.Dry, 'dry'],
  [Thermostat.SystemMode.FanOnly, 'fanOnly'],
]);

/**
 * Plan the commands for a Matter systemMode change (off / mode switches).
 * Skips commands whose value already matches the cached state.
 *
 * @param {ClimateState} state - The cached state of the unit.
 * @param {Thermostat.SystemMode} systemMode - The requested Matter system mode.
 * @returns {WriteCommand[]} The commands to send (may be empty).
 */
export function planSystemModeChange(state: ClimateState, systemMode: Thermostat.SystemMode): WriteCommand[] {
  if (systemMode === Thermostat.SystemMode.Off) {
    return state.onOff ? [{ dataPoint: 'onOffMode', path: null, value: 'off' }] : [];
  }
  const mode = MODE_BY_SYSTEM_MODE.get(systemMode);
  if (!mode || (state.supportedModes.length > 0 && !state.supportedModes.includes(mode))) return [];
  const commands: WriteCommand[] = [];
  if (state.operationMode !== mode) commands.push({ dataPoint: 'operationMode', path: null, value: mode });
  if (!state.onOff) commands.push({ dataPoint: 'onOffMode', path: null, value: 'on' });
  return commands;
}

/**
 * Round to the device's setpoint step and clamp into the allowed range.
 *
 * @param {number} celsius - The requested temperature in °C.
 * @param {SetpointRange} range - The device's setpoint range.
 * @returns {number} The valid setpoint value.
 */
export function clampSetpoint(celsius: number, range: SetpointRange): number {
  const step = range.step > 0 ? range.step : 0.5;
  const rounded = Math.round(celsius / step) * step;
  // Avoid floating point artifacts like 22.500000000000004.
  const clean = Math.round(rounded * 100) / 100;
  return Math.min(range.max, Math.max(range.min, clean));
}

/**
 * Plan the command for a Matter heating/cooling setpoint change.
 *
 * The setpoint is written to the matching Onecta operation mode. When the unit runs in
 * auto mode (single setpoint), only the cooling setpoint is mapped (to the auto setpoint);
 * a heating setpoint change is ignored to avoid two conflicting writes.
 *
 * @param {ClimateState} state - The cached state of the unit.
 * @param {'heating' | 'cooling'} kind - Which Matter setpoint changed.
 * @param {number} celsius - The requested temperature in °C.
 * @returns {WriteCommand[]} The command to send (may be empty).
 */
export function planSetpointChange(state: ClimateState, kind: 'heating' | 'cooling', celsius: number): WriteCommand[] {
  let mode: OnectaOperationMode = kind;
  let range = kind === 'heating' ? state.heatingSetpoint : state.coolingSetpoint;
  if (state.operationMode === 'auto' && state.autoSetpoint) {
    if (kind === 'heating') return [];
    mode = 'auto';
    range = state.autoSetpoint;
  }
  if (!range) return [];
  const value = clampSetpoint(celsius, range);
  if (value === range.value) return [];
  return [{ dataPoint: 'temperatureControl', path: `/operationModes/${mode}/setpoints/roomTemperature`, value }];
}

/**
 * Plan the commands for a Matter fan percent change. 0 % switches the fan to auto.
 *
 * @param {ClimateState} state - The cached state of the unit.
 * @param {number | null} percent - The requested fan percentage (null = no change).
 * @returns {WriteCommand[]} The commands to send (may be empty).
 */
export function planFanPercentChange(state: ClimateState, percent: number | null): WriteCommand[] {
  if (!state.fan || percent === null) return [];
  const base = `/operationModes/${state.operationMode}/fanSpeed`;
  if (percent === 0) {
    return state.fan.mode === 'auto' ? [] : [{ dataPoint: 'fanControl', path: `${base}/currentMode`, value: 'auto' }];
  }
  const maxSpeed = state.fan.maxSpeed ?? 5;
  const speed = Math.min(maxSpeed, Math.max(1, Math.round((percent / 100) * maxSpeed)));
  const commands: WriteCommand[] = [];
  if (state.fan.mode !== 'fixed') commands.push({ dataPoint: 'fanControl', path: `${base}/currentMode`, value: 'fixed' });
  if (state.fan.speed !== speed || state.fan.mode !== 'fixed') commands.push({ dataPoint: 'fanControl', path: `${base}/modes/fixed`, value: speed });
  return commands;
}

/**
 * Plan the commands for a Matter fan mode change (Auto/Low/Medium/High).
 *
 * @param {ClimateState} state - The cached state of the unit.
 * @param {FanControl.FanMode} fanMode - The requested Matter fan mode.
 * @returns {WriteCommand[]} The commands to send (may be empty).
 */
export function planFanModeChange(state: ClimateState, fanMode: FanControl.FanMode): WriteCommand[] {
  if (!state.fan) return [];
  const base = `/operationModes/${state.operationMode}/fanSpeed`;
  switch (fanMode) {
    case FanControl.FanMode.Auto:
      return state.fan.mode === 'auto' ? [] : [{ dataPoint: 'fanControl', path: `${base}/currentMode`, value: 'auto' }];
    case FanControl.FanMode.Low:
      return state.fan.mode === 'quiet' ? [] : [{ dataPoint: 'fanControl', path: `${base}/currentMode`, value: 'quiet' }];
    case FanControl.FanMode.Medium:
      return planFanPercentChange(state, 50);
    case FanControl.FanMode.High:
      return planFanPercentChange(state, 100);
    default:
      // Off/On have no Onecta equivalent (the fan follows the unit), ignore.
      return [];
  }
}

/**
 * Apply a successfully sent command to the cached state, so follow-up planning
 * and Matter updates use the new values until the next cloud poll confirms them.
 *
 * @param {ClimateState} state - The cached state to mutate.
 * @param {WriteCommand} command - The command that was accepted by the API.
 */
export function applyWriteToState(state: ClimateState, command: WriteCommand): void {
  if (command.dataPoint === 'onOffMode') {
    state.onOff = command.value === 'on';
    return;
  }
  if (command.dataPoint === 'operationMode') {
    const mode = MODE_BY_SYSTEM_MODE.values();
    for (const candidate of mode) {
      if (candidate === command.value) {
        state.operationMode = candidate;
        return;
      }
    }
    return;
  }
  if (command.dataPoint === 'temperatureControl' && command.path && typeof command.value === 'number') {
    const match = /^\/operationModes\/(\w+)\/setpoints\/roomTemperature$/.exec(command.path);
    const target = match?.[1] === 'heating' ? state.heatingSetpoint : match?.[1] === 'cooling' ? state.coolingSetpoint : match?.[1] === 'auto' ? state.autoSetpoint : undefined;
    if (target) target.value = command.value;
    return;
  }
  if (command.dataPoint === 'fanControl' && command.path && state.fan) {
    if (command.path.endsWith('/currentMode') && (command.value === 'auto' || command.value === 'quiet' || command.value === 'fixed')) {
      state.fan.mode = command.value;
    } else if (command.path.endsWith('/modes/fixed') && typeof command.value === 'number') {
      state.fan.speed = command.value;
    }
  }
}
